import fs from "node:fs";
import path from "node:path";
import type { AIModel, Provider } from "../db/entities/AIModel.js";
import { decryptSecret } from "../lib/secret.js";
import {
  employeeGooseDir,
  employeeOpencodeDir,
  gooseCredsPath,
  opencodeCredsPath,
} from "./paths.js";
import { ensureDir } from "./paths.js";

/**
 * `customEndpoint` auth mode lets an AI Employee talk to a self-hosted
 * OpenAI-compatible server (Ollama / vLLM / llama.cpp / LM Studio / …)
 * configured entirely from the Genosyn UI — no terminal required.
 *
 * Two harnesses can carry the traffic:
 *  - opencode: synthesize a provider in opencode.json + drop an auth.json
 *  - goose:    seed a minimal config.yaml + inject OPENAI_HOST env vars
 *
 * configJson shape (encrypted-at-rest fields are AES-256-GCM via the
 * shared `lib/secret.ts` helper, keyed off `config.sessionSecret`):
 *
 *   {
 *     baseURLEncrypted: string,   // load-bearing — connection signal
 *     baseURLPreview:   string,   // host-only, safe to render in the UI
 *     apiKeyEncrypted?: string,   // optional — most local servers ignore the key
 *     apiKeyPreview?:   string,
 *     modelId:          string,   // raw model id, e.g. "qwen2.5-coder:32b"
 *   }
 */
export type CustomEndpointConfig = {
  baseURL: string;
  apiKey: string | null;
  modelId: string;
};

/** Synthetic provider slug we use inside the materialized harness configs. */
export const CUSTOM_OPENCODE_PROVIDER_SLUG = "local";
export const CUSTOM_GOOSE_PROVIDER_SLUG = "openai";

/**
 * Decrypt the customEndpoint blob from an AIModel row. Returns `null` when
 * the row isn't in customEndpoint mode, when configJson is malformed, or
 * when the base URL is missing — callers should treat any null as
 * "credentials not present, surface an error".
 */
export function readCustomEndpoint(m: AIModel): CustomEndpointConfig | null {
  if (m.authMode !== "customEndpoint") return null;
  let cfg: Record<string, unknown> = {};
  try {
    const v = JSON.parse(m.configJson || "{}");
    if (v && typeof v === "object") cfg = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const enc = typeof cfg.baseURLEncrypted === "string" ? (cfg.baseURLEncrypted as string) : null;
  if (!enc) return null;
  let baseURL: string;
  try {
    baseURL = decryptSecret(enc);
  } catch {
    return null;
  }
  const keyEnc = typeof cfg.apiKeyEncrypted === "string" ? (cfg.apiKeyEncrypted as string) : null;
  let apiKey: string | null = null;
  if (keyEnc) {
    try {
      apiKey = decryptSecret(keyEnc);
    } catch {
      apiKey = null;
    }
  }
  const modelId = typeof cfg.modelId === "string" ? (cfg.modelId as string).trim() : "";
  if (!modelId) return null;
  return { baseURL: baseURL.trim(), apiKey, modelId };
}

/**
 * Render a base URL down to a host-only preview safe to show in the UI:
 *   http://localhost:11434/v1  →  localhost:11434
 *   https://api.together.xyz/v1  →  api.together.xyz
 *   not a URL  →  the original string (trimmed)
 */
export function previewBaseURL(s: string): string {
  const trimmed = s.trim();
  try {
    const u = new URL(trimmed);
    return u.host;
  } catch {
    return trimmed;
  }
}

/**
 * Custom-endpoint payload for opencode. The harness writes two files:
 *   <employee>/.opencode/opencode/auth.json   (the key)
 *   <employee>/opencode.json                  (the provider declaration)
 *
 * Returns the synthetic provider slug + the model id so the runner can
 * pass `--model <slug>/<modelId>` to opencode.
 */
export function materializeOpencodeCustomEndpoint(
  companySlug: string,
  employeeSlug: string,
  cfg: CustomEndpointConfig,
): { providerSlug: string; modelId: string } {
  const slug = CUSTOM_OPENCODE_PROVIDER_SLUG;
  // Auth file lives where opencode expects it under XDG_DATA_HOME. We point
  // XDG_DATA_HOME at the employee's .opencode dir, so auth.json ends up at
  // .opencode/opencode/auth.json. Read-merge-write so we don't trample a
  // subscription auth blob the user may also have signed into.
  const authPath = opencodeCredsPath(companySlug, employeeSlug);
  ensureDir(path.dirname(authPath));
  let auth: Record<string, unknown> = {};
  try {
    if (fs.existsSync(authPath)) {
      const raw = fs.readFileSync(authPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") auth = parsed as Record<string, unknown>;
    }
  } catch {
    auth = {};
  }
  auth[slug] = { type: "api", key: cfg.apiKey ?? "not-needed" };
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf8");
  return { providerSlug: slug, modelId: cfg.modelId };
}

/**
 * Provider declaration we splice into opencode.json's `provider` block. The
 * mcp.ts materializer calls this when authMode === "customEndpoint" so the
 * file we already write (for MCP + permissions) carries the synthetic
 * provider too — one file write, not two.
 */
export type OpencodeCustomProviderBlock = Record<
  string,
  {
    npm: string;
    options: { baseURL: string };
    models: Record<string, Record<string, never>>;
  }
>;

export function buildOpencodeProviderBlock(
  cfg: CustomEndpointConfig,
): OpencodeCustomProviderBlock {
  const slug = CUSTOM_OPENCODE_PROVIDER_SLUG;
  // `@ai-sdk/openai-compatible` is the universal adapter opencode pulls in
  // for arbitrary OpenAI-compatible endpoints. opencode resolves npm
  // packages on-demand the first time a synthetic provider is referenced.
  return {
    [slug]: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: cfg.baseURL },
      models: { [cfg.modelId]: {} },
    },
  };
}

/**
 * Materialize a minimal goose config.yaml so goose's `openai` provider is
 * pre-configured to point at the user's endpoint. Goose refuses to start
 * if GOOSE_PROVIDER references a provider that isn't in config.yaml, so we
 * have to write the file before the spawn — env vars alone aren't enough.
 *
 * We write YAML by hand (no js-yaml dep). The keys we set are flat strings
 * and the values are safe — slugs + a model id we validate at the route
 * layer — so a string template stays readable and bounded.
 */
export function materializeGooseCustomEndpoint(
  companySlug: string,
  employeeSlug: string,
  cfg: CustomEndpointConfig,
): { providerSlug: string; modelId: string } {
  const slug = CUSTOM_GOOSE_PROVIDER_SLUG;
  const configPath = gooseCredsPath(companySlug, employeeSlug);
  ensureDir(path.dirname(configPath));
  const lines = [
    "# Materialized by Genosyn — overwritten on every spawn when authMode=customEndpoint.",
    "# Edit the AI Model from the app instead.",
    `GOOSE_PROVIDER: ${slug}`,
    `GOOSE_MODEL: ${cfg.modelId}`,
    "GOOSE_MODE: auto",
    "extensions: {}",
    "",
  ];
  fs.writeFileSync(configPath, lines.join("\n"), "utf8");
  return { providerSlug: slug, modelId: cfg.modelId };
}

/** Per-harness env vars goose needs to actually call the endpoint. */
export function buildGooseCustomEndpointEnv(cfg: CustomEndpointConfig): NodeJS.ProcessEnv {
  // Goose's OpenAI provider supports both forms — older builds read
  // OPENAI_HOST + OPENAI_BASE_PATH, newer builds prefer OPENAI_BASE_URL.
  // Set all three; whichever goose picks up first wins. OPENAI_API_KEY is
  // mandatory even when the upstream ignores it (the OpenAI SDK refuses
  // empty keys).
  const u = (() => {
    try {
      return new URL(cfg.baseURL);
    } catch {
      return null;
    }
  })();
  const out: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: cfg.apiKey ?? "not-needed",
    OPENAI_BASE_URL: cfg.baseURL,
    GOOSE_PROVIDER: CUSTOM_GOOSE_PROVIDER_SLUG,
    GOOSE_MODEL: cfg.modelId,
  };
  if (u) {
    out.OPENAI_HOST = `${u.protocol}//${u.host}`;
    out.OPENAI_BASE_PATH = u.pathname.replace(/\/$/, "") || "/v1/chat/completions";
  }
  return out;
}

/**
 * Empty `.opencode/` and `.goose/` config dirs so a fresh customEndpoint
 * configuration doesn't leak stale auth from a prior provider/mode. Called
 * by the route on customEndpoint save when the auth mode just changed.
 */
export function clearHarnessCacheDir(provider: Provider, coSlug: string, empSlug: string): void {
  let dir: string | null = null;
  if (provider === "opencode") dir = employeeOpencodeDir(coSlug, empSlug);
  if (provider === "goose") dir = employeeGooseDir(coSlug, empSlug);
  if (!dir) return;
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: the spawn-time materializer will write what it needs.
  }
}
