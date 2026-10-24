import type { AIModel } from "../db/entities/AIModel.js";
import { fingerprintSecret } from "../lib/secret.js";
import { readCustomEndpoint } from "./customEndpoint.js";
import { decryptApiKey, holdsApiKeys, readApiKeys } from "./modelApiKeys.js";
import { isModelConnected } from "./providers.js";

/**
 * Finding a company's AI Models that are exactly the same model with the same
 * credentials — usually copies the old per-employee Reuse made, or one key
 * pasted on two employees before models were shared.
 *
 * Two models are exact duplicates when they have the same service, sign-in
 * kind and model, reach the same endpoint, and hold the same keys in the same
 * order. Keys and endpoints are compared by keyed fingerprints computed in
 * memory (`fingerprintSecret`) — never by their plaintext, which no caller
 * sees, and never by their ciphertext, which differs every time a key is
 * saved. A fingerprint is never stored, logged or sent anywhere: callers get
 * only which model ids match.
 *
 * Duplicates are only ever offered for merging, in Settings → AI Models; the
 * settings that may differ between them (context window, concurrent Runs) are
 * the kept model's after a merge. A ChatGPT sign-in is never a duplicate: two
 * sign-ins are two sessions even on one account, and nothing on the row says
 * which account it is. A model still waiting for its credential has nothing
 * to compare.
 */

const KEY_SCOPE = "ai-model-key";
const ENDPOINT_SCOPE = "ai-model-endpoint";

/** The endpoint as a server sees it: scheme and host lowercased, no trailing slash. */
export function normalizeEndpoint(baseURL: string): string {
  const raw = baseURL.trim().replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return raw;
  }
}

/**
 * What makes this model *this* model, as one opaque string — or null when it
 * can't be a duplicate (a ChatGPT sign-in, a model not connected yet, or a
 * credential that no longer decrypts, which must never match another).
 */
export function modelFingerprint(model: AIModel): string | null {
  if (!isModelConnected(model)) return null;
  if (holdsApiKeys(model)) {
    const keys: string[] = [];
    for (const key of readApiKeys(model.configJson)) {
      const plaintext = decryptApiKey(key);
      if (!plaintext) return null;
      keys.push(fingerprintSecret(plaintext, KEY_SCOPE));
    }
    if (keys.length === 0) return null;
    return ["apikey", model.provider, model.model.trim(), keys.join(",")].join("\u0000");
  }
  if (model.authMode === "customEndpoint" && model.provider === "custom") {
    const endpoint = readCustomEndpoint(model);
    if (!endpoint) return null;
    return [
      "customEndpoint",
      model.provider,
      endpoint.modelId,
      fingerprintSecret(normalizeEndpoint(endpoint.baseURL), ENDPOINT_SCOPE),
      endpoint.apiKey ? fingerprintSecret(endpoint.apiKey, KEY_SCOPE) : "",
    ].join("\u0000");
  }
  return null;
}

/**
 * For each model that has exact duplicates among `models`, the ids of the
 * others — oldest first, so the model a merge would keep by default leads.
 * Models with no duplicate are absent from the map.
 */
export function duplicateIdsByModel(models: readonly AIModel[]): Map<string, string[]> {
  const groups = new Map<string, AIModel[]>();
  for (const model of models) {
    const fingerprint = modelFingerprint(model);
    if (!fingerprint) continue;
    const group = groups.get(fingerprint);
    if (group) group.push(model);
    else groups.set(fingerprint, [model]);
  }
  const result = new Map<string, string[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    for (const model of ordered) {
      result.set(
        model.id,
        ordered.filter((other) => other.id !== model.id).map((other) => other.id),
      );
    }
  }
  return result;
}

/** Are `a` and `b` exact duplicates of each other right now? */
export function areExactDuplicates(a: AIModel, b: AIModel): boolean {
  const fingerprint = modelFingerprint(a);
  return fingerprint !== null && fingerprint === modelFingerprint(b);
}
