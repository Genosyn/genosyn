import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AIModel } from "../../db/entities/AIModel.js";
import { decryptSecret } from "../../lib/secret.js";
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
 * vLLM publishes `max_model_len` on each model card of its OpenAI-compatible
 * `/v1/models`. It is not part of the OpenAI spec, so the SDK doesn't type it
 * and other servers (Ollama, LM Studio, llama.cpp) may omit it or name it
 * something else — in which case we report unknown rather than guess.
 */
async function probeOpenAICompatible(model: AIModel): Promise<number | null> {
  const cfg = readCustomEndpoint(model);
  if (!cfg) return null;
  const client = new OpenAI({
    apiKey: cfg.apiKey || "not-needed",
    baseURL: normalizeBaseURL(cfg.baseURL),
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });
  const list = await client.models.list();
  for (const entry of list.data) {
    if (entry.id !== cfg.modelId) continue;
    return plausible(readNumber(entry, "max_model_len"));
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
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function plausible(n: number | null): number | null {
  if (n === null) return null;
  const i = Math.floor(n);
  return i >= MIN_PLAUSIBLE && i <= MAX_PLAUSIBLE ? i : null;
}
