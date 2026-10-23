import { randomUUID } from "node:crypto";
import type { AIModel } from "../db/entities/AIModel.js";
import type { AIModelKeyHealth, ApiKeyFailureKind } from "../db/entities/AIModelKeyHealth.js";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/secret.js";

/**
 * The API keys an API-key AI Model holds: a primary key, which every request
 * tries first, and any number of backup keys, tried in order when a provider
 * refuses the key a request was sent with (see `agent/apiKeyRing.ts`). There
 * is no cap on how many.
 *
 * They live in `AIModel.configJson` beside every other credential, each one
 * encrypted with the company's scope exactly like the primary always was. The
 * primary stays where it has always been — `apiKeyEncrypted` / `apiKeyPreview`
 * at the top level — so every reader that predates backup keys (connection
 * status, reuse, the context-window probe, transcription) keeps working; the
 * backups follow it in `backupKeys`, in the order they are tried:
 *
 *   { apiKeyEncrypted, apiKeyPreview, apiKeyId?, apiKeyAddedAt?,
 *     backupKeys?: [{ id, apiKeyEncrypted, apiKeyPreview, addedAt? }] }
 *
 * A key's `id` stays with it when the keys are reordered and names its health
 * row (`AIModelKeyHealth`). A primary saved before backup keys existed has no
 * stored id and is always called {@link LEGACY_PRIMARY_KEY_ID}. Only the
 * masked preview ever leaves the server.
 */

/** The id of a primary key saved before keys had ids of their own. */
export const LEGACY_PRIMARY_KEY_ID = "primary";

/** One API key as it is stored, never decrypted. */
export type StoredApiKey = {
  id: string;
  apiKeyEncrypted: string;
  apiKeyPreview: string;
  /** ISO time the key was added; null for a primary saved before backup keys. */
  addedAt: string | null;
};

/** One API key as the model proxy uses it: plaintext, held only in memory. */
export type ApiKeySecret = { id: string; apiKey: string; preview: string };

function parseConfig(configJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Every key, primary first, in the order requests try them. */
export function readApiKeys(configJson: string | null | undefined): StoredApiKey[] {
  const cfg = parseConfig(configJson);
  const keys: StoredApiKey[] = [];
  const primary = text(cfg.apiKeyEncrypted);
  if (primary) {
    keys.push({
      id: text(cfg.apiKeyId) ?? LEGACY_PRIMARY_KEY_ID,
      apiKeyEncrypted: primary,
      apiKeyPreview: text(cfg.apiKeyPreview) ?? "",
      addedAt: text(cfg.apiKeyAddedAt),
    });
  }
  if (Array.isArray(cfg.backupKeys)) {
    for (const raw of cfg.backupKeys) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const id = text(entry.id);
      const encrypted = text(entry.apiKeyEncrypted);
      if (!id || !encrypted || keys.some((key) => key.id === id)) continue;
      keys.push({
        id,
        apiKeyEncrypted: encrypted,
        apiKeyPreview: text(entry.apiKeyPreview) ?? "",
        addedAt: text(entry.addedAt),
      });
    }
  }
  return keys;
}

/**
 * `configJson` holding exactly `keys` — the first as the primary, the rest as
 * backups in order. Every other field is kept as it was.
 */
export function writeApiKeys(
  configJson: string | null | undefined,
  keys: readonly StoredApiKey[],
): string {
  const cfg = parseConfig(configJson);
  delete cfg.apiKeyEncrypted;
  delete cfg.apiKeyPreview;
  delete cfg.apiKeyId;
  delete cfg.apiKeyAddedAt;
  delete cfg.backupKeys;
  const [primary, ...backups] = keys;
  if (primary) {
    cfg.apiKeyEncrypted = primary.apiKeyEncrypted;
    cfg.apiKeyPreview = primary.apiKeyPreview;
    // A legacy primary keeps no stored id, so it reads back as itself.
    if (primary.id !== LEGACY_PRIMARY_KEY_ID) cfg.apiKeyId = primary.id;
    if (primary.addedAt) cfg.apiKeyAddedAt = primary.addedAt;
  }
  if (backups.length > 0) {
    cfg.backupKeys = backups.map((key) => ({
      id: key.id,
      apiKeyEncrypted: key.apiKeyEncrypted,
      apiKeyPreview: key.apiKeyPreview,
      ...(key.addedAt ? { addedAt: key.addedAt } : {}),
    }));
  }
  return JSON.stringify(cfg);
}

/** A key ready to store: encrypted with the company's scope, with a fresh id. */
export function newStoredApiKey(apiKey: string, companyId: string, now = new Date()): StoredApiKey {
  return {
    id: randomUUID(),
    apiKeyEncrypted: encryptSecret(apiKey, companyId),
    apiKeyPreview: maskSecret(apiKey),
    addedAt: now.toISOString(),
  };
}

/** The key's plaintext, or null when it can no longer be decrypted. */
export function decryptApiKey(key: StoredApiKey): string | null {
  try {
    return decryptSecret(key.apiKeyEncrypted);
  } catch {
    return null;
  }
}

/**
 * Every key that still decrypts, in order. A key that no longer does is left
 * out rather than failing the others; the caller decides what none means.
 */
export function decryptApiKeys(configJson: string | null | undefined): ApiKeySecret[] {
  const secrets: ApiKeySecret[] = [];
  for (const key of readApiKeys(configJson)) {
    const apiKey = decryptApiKey(key);
    if (apiKey) secrets.push({ id: key.id, apiKey, preview: key.apiKeyPreview });
  }
  return secrets;
}

/** The stored key whose plaintext is `apiKey`, if this AI Model already holds it. */
export function findApiKey(
  keys: readonly StoredApiKey[],
  apiKey: string,
): StoredApiKey | undefined {
  return keys.find((key) => decryptApiKey(key) === apiKey);
}

/** Does this AI Model take API keys — and so backup keys? */
export function holdsApiKeys(model: Pick<AIModel, "authMode" | "provider">): boolean {
  return (
    model.authMode === "apikey" && (model.provider === "anthropic" || model.provider === "openai")
  );
}

/** One API key as a Member sees it: a preview and how it has been doing. */
export type PublicApiKey = {
  id: string;
  /** Masked, e.g. `sk-…c123`; never the key. */
  preview: string;
  addedAt: string | null;
  /** When a request on it last succeeded. */
  lastUsedAt: string | null;
  /** When a provider last refused it, with the status, kind and its words. */
  lastErrorAt: string | null;
  lastErrorStatus: number | null;
  lastErrorKind: ApiKeyFailureKind | null;
  lastError: string | null;
  /** While set, requests try the other keys first. */
  restingUntil: string | null;
};

/**
 * The keys of an API-key AI Model for the wire, in the order they are tried,
 * each with its health. Empty for every other kind of AI Model — a custom
 * endpoint's optional key is not part of this.
 */
export function publicApiKeys(
  model: Pick<AIModel, "authMode" | "provider" | "configJson">,
  health: readonly AIModelKeyHealth[],
  options: { now?: number; restingUntil?: (keyId: string) => number } = {},
): PublicApiKey[] {
  if (!holdsApiKeys(model)) return [];
  const now = options.now ?? Date.now();
  const byKey = new Map(health.map((row) => [row.keyId, row]));
  return readApiKeys(model.configJson).map((key) => {
    const row = byKey.get(key.id);
    const resting = Math.max(
      row?.coolDownUntil?.getTime() ?? 0,
      options.restingUntil?.(key.id) ?? 0,
    );
    return {
      id: key.id,
      preview: key.apiKeyPreview || "••••",
      addedAt: key.addedAt,
      lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
      lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
      lastErrorStatus: row?.lastErrorStatus ?? null,
      lastErrorKind: row?.lastErrorKind ?? null,
      lastError: row?.lastErrorMessage ?? null,
      restingUntil: resting > now ? new Date(resting).toISOString() : null,
    };
  });
}
