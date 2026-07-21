import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AIModel } from "../../db/entities/AIModel.js";
import { decryptSecret } from "../../lib/secret.js";
import { assertSafeOutboundUrl } from "../../lib/outboundUrl.js";
import { readCustomEndpoint } from "../customEndpoint.js";
import { normalizeBaseURL } from "./modelClients/index.js";

/**
 * Ask a provider how many tokens its model can take.
 *
 * Genosyn injects the Soul, every Skill, and the whole tool catalog on every
 * turn, then appends a tool result per step — so how much room there is decides
 * whether a run finishes or dies on a provider 400. We can't infer it: model ids
 * are free text, and a custom endpoint can serve any weights at any
 * `--max-model-len`. So we ask the endpoint we already hold credentials for,
 * once, when the credential is saved.
 *
 * Every failure path returns null ("unknown") rather than throwing or guessing.
 * A wrong number is worse than no number: too high fails the run anyway, too low
 * truncates work that would have fit. Callers must handle null.
 *
 * Not every server reports one (plain Ollama doesn't, and OpenAI's own API
 * doesn't), so "unknown" is a normal outcome rather than an error — which is why
 * an operator can set the number by hand instead. A manually-set window is
 * recorded as `AIModel.contextWindowSource = "manual"` and this probe never
 * overwrites it; see `routes/models.ts`.
 */

/** A probe is a nicety on a save path — never let it hang the request. */
const PROBE_TIMEOUT_MS = 8_000;

/** Reject nonsense so a malformed field can't poison the budget maths. */
const MIN_PLAUSIBLE = 1_024;
const MAX_PLAUSIBLE = 20_000_000;

export async function probeContextWindow(model: AIModel): Promise<number | null> {
  try {
    if (model.authMode === "customEndpoint") return await probeOpenAICompatible(model);
    if (model.provider === "anthropic") return await probeAnthropic(model);
    // OpenAI's /v1/models reports no context length, so there is nothing to ask.
    return null;
  } catch {
    // Unreachable host, bad key, wrong shape — all just mean "unknown".
    return null;
  }
}

/**
 * Is there any point asking this provider for a window?
 *
 * Mirrors the dispatch in {@link probeContextWindow} — kept here beside it so
 * the two can't drift. The UI reads this to decide whether "unknown" is a
 * transient state worth offering a retry for, or simply how this provider is:
 * there's no sense showing a Refresh button that is guaranteed to find nothing.
 */
export function canProbeContextWindow(model: AIModel): boolean {
  return model.authMode === "customEndpoint" || model.provider === "anthropic";
}

/**
 * Where each OpenAI-compatible server hides the context length on its
 * `/v1/models` card. None of this is in the OpenAI spec — the spec's card is
 * just id/object/created/owned_by — so every server that reports one invented
 * its own field, and the SDK types none of them.
 *
 * Ordered by how specific the name is: `max_model_len` is what the server was
 * actually launched with (vLLM's `--max-model-len`), whereas `n_ctx_train` is
 * what the weights were trained at, which is only a fallback because a server
 * can be serving them at less.
 */
const WINDOW_FIELDS = [
  "max_model_len", // vLLM
  "max_context_length", // LM Studio
  "context_length", // some gateways (OpenRouter-style cards)
  "n_ctx", // llama.cpp server
  "n_ctx_train", // llama.cpp, trained-at length
] as const;

/**
 * Read the window off the model's card, checking every field name we know.
 *
 * Servers that report nothing (plain Ollama) leave us at unknown, which is the
 * honest answer — an operator can set the number by hand instead.
 */
async function probeOpenAICompatible(model: AIModel): Promise<number | null> {
  const cfg = readCustomEndpoint(model);
  if (!cfg) return null;
  await assertSafeOutboundUrl(cfg.baseURL);
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: normalizeBaseURL(cfg.baseURL),
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });
  const list = await client.models.list();
  for (const entry of list.data) {
    if (entry.id !== cfg.modelId) continue;
    return readWindow(entry);
  }
  return null;
}

/** Try each known field on the card, then inside a `meta` sub-object (llama.cpp). */
function readWindow(entry: unknown): number | null {
  for (const field of WINDOW_FIELDS) {
    const v = plausible(readNumber(entry, field));
    if (v !== null) return v;
  }
  const meta = readObject(entry, "meta");
  if (!meta) return null;
  for (const field of WINDOW_FIELDS) {
    const v = plausible(readNumber(meta, field));
    if (v !== null) return v;
  }
  return null;
}

/** Anthropic's models API reports the context window as `max_input_tokens`. */
async function probeAnthropic(model: AIModel): Promise<number | null> {
  const apiKey = readApiKey(model);
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
  const found = await client.models.retrieve(model.model);
  return plausible(readNumber(found, "max_input_tokens"));
}

function readApiKey(model: AIModel): string | null {
  try {
    const cfg = JSON.parse(model.configJson || "{}") as Record<string, unknown>;
    const enc = cfg.apiKeyEncrypted;
    if (typeof enc !== "string") return null;
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

/** Pull a numeric field off a provider payload that our SDK types don't model. */
function readNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") return null;
  const v = (source as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Some servers stringify their numbers. Accept a clean integer string, but
  // don't get clever — anything else is a shape we don't understand.
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Pull a nested object off a provider payload (llama.cpp nests under `meta`). */
function readObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== "object") return null;
  const v = (source as Record<string, unknown>)[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function plausible(n: number | null): number | null {
  if (n === null) return null;
  const i = Math.floor(n);
  return i >= MIN_PLAUSIBLE && i <= MAX_PLAUSIBLE ? i : null;
}
