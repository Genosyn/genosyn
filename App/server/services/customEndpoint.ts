import type { AIModel } from "../db/entities/AIModel.js";
import { decryptSecret } from "../lib/secret.js";

/**
 * `customEndpoint` auth mode lets an AI Employee talk to a self-hosted
 * OpenAI-compatible server (Ollama / vLLM / llama.cpp / LM Studio / a gateway)
 * configured entirely from the Genosyn UI. The decrypted config feeds an
 * OpenAI-compatible client directly (see services/agent/modelClients) — there
 * is no config file on disk any more.
 *
 * configJson shape (encrypted-at-rest fields are AES-256-GCM via `lib/secret`,
 * keyed off `config.sessionSecret`):
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

/**
 * Decrypt the customEndpoint blob from an AIModel row. Returns `null` when the
 * row isn't in customEndpoint mode, when configJson is malformed, or when the
 * base URL / model id is missing — callers treat any null as "not configured".
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
