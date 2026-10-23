import { In, Not, type EntityManager } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelKeyHealth, type ApiKeyFailureKind } from "../db/entities/AIModelKeyHealth.js";
import { readApiKeys } from "./modelApiKeys.js";

/**
 * How each of an AI Model's API keys has been doing — the memory behind
 * backup-key failover (`agent/apiKeyRing.ts`) and the health an owner reads in
 * the model's settings.
 *
 * Two layers. A key that was just refused **rests** in this process's memory,
 * so the requests right behind it start on another key instead of hitting the
 * refused one first; that is the hot path, read on every model request, and
 * never waits on the database. The same rest, and when each key last worked or
 * was refused and why, is also written to `AIModelKeyHealth` — for the
 * settings page, and so another App replica, or this one after a restart,
 * starts a turn already knowing ({@link loadKeyRests}).
 *
 * Writes are best effort and never throw: a model request must not fail
 * because its key's health could not be saved. "Last used" is written at most
 * once a minute per key, like an API key's own `lastUsedAt`, except straight
 * after a refusal, when the next success clears the rest at once.
 */

/** How often one process writes a key's "last used" while it keeps working. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Above this many remembered rests, expired ones are swept out. */
const SWEEP_AT = 1_000;

const rests = new Map<string, number>();
const lastUsedWrites = new Map<string, number>();

function slot(modelId: string, keyId: string): string {
  return `${modelId}\u0000${keyId}`;
}

function modelOf(entry: string): string {
  return entry.slice(0, entry.indexOf("\u0000"));
}

/** Until when (epoch ms) a key rests after a refusal; 0 when it doesn't. */
export function keyRestingUntil(modelId: string, keyId: string, now = Date.now()): number {
  const entry = slot(modelId, keyId);
  const until = rests.get(entry) ?? 0;
  if (until > now) return until;
  if (until) rests.delete(entry);
  return 0;
}

/** Rest a key until `until` (epoch ms), keeping a longer rest it already has. */
export function restKey(modelId: string, keyId: string, until: number, now = Date.now()): void {
  const entry = slot(modelId, keyId);
  rests.set(entry, Math.max(rests.get(entry) ?? 0, until));
  if (rests.size > SWEEP_AT) {
    for (const [key, value] of rests) if (value <= now) rests.delete(key);
  }
}

/** A key that just worked rests no longer. */
export function wakeKey(modelId: string, keyId: string): void {
  rests.delete(slot(modelId, keyId));
}

/**
 * Adopt the rests recorded for this AI Model's keys — by another App replica,
 * or by this process before a restart. Read once as a turn starts.
 */
export async function loadKeyRests(modelId: string, now = Date.now()): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  try {
    const rows = await AppDataSource.getRepository(AIModelKeyHealth).find({
      where: { modelId },
      select: { keyId: true, coolDownUntil: true },
    });
    for (const row of rows) {
      const until = row.coolDownUntil?.getTime() ?? 0;
      if (until > now) restKey(modelId, row.keyId, until, now);
    }
  } catch {
    // Health is advisory; the turn starts on the configured order instead.
  }
}

/** A refusal as it is recorded: what kind, the status, the provider's words. */
export type RecordedRefusal = {
  kind: ApiKeyFailureKind;
  status: number;
  /** One line, with every key already redacted. */
  message: string;
  /** Until when (epoch ms) the key rests. */
  restUntil: number;
};

/** Remember that a request on this key just succeeded. */
export async function recordKeySuccess(
  modelId: string,
  keyId: string,
  at = new Date(),
): Promise<void> {
  const entry = slot(modelId, keyId);
  const last = lastUsedWrites.get(entry);
  if (last !== undefined && at.getTime() - last < LAST_USED_WRITE_INTERVAL_MS) return;
  lastUsedWrites.set(entry, at.getTime());
  await writeHealth(modelId, keyId, { lastUsedAt: at, coolDownUntil: null });
}

/** Remember that a provider just refused this key, and why. */
export async function recordKeyRefusal(
  modelId: string,
  keyId: string,
  refusal: RecordedRefusal,
  at = new Date(),
): Promise<void> {
  // The next success writes straight away, so the rest is cleared at once.
  lastUsedWrites.delete(slot(modelId, keyId));
  await writeHealth(modelId, keyId, {
    lastErrorAt: at,
    lastErrorStatus: refusal.status,
    lastErrorKind: refusal.kind,
    lastErrorMessage: refusal.message.slice(0, 300),
    coolDownUntil: new Date(refusal.restUntil),
  });
}

type HealthValues = Partial<
  Pick<
    AIModelKeyHealth,
    | "lastUsedAt"
    | "lastErrorAt"
    | "lastErrorStatus"
    | "lastErrorKind"
    | "lastErrorMessage"
    | "coolDownUntil"
  >
>;

async function writeHealth(modelId: string, keyId: string, values: HealthValues): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  try {
    // Only for a key the saved AI Model holds right now: a key still being
    // tested before it is saved, or one removed while a request was out on
    // it, leaves no row behind.
    const model = await AppDataSource.getRepository(AIModel).findOne({
      where: { id: modelId },
      select: { id: true, configJson: true },
    });
    if (!model || !readApiKeys(model.configJson).some((key) => key.id === keyId)) return;
    await AppDataSource.getRepository(AIModelKeyHealth).upsert(
      { modelId, keyId, ...values },
      { conflictPaths: ["modelId", "keyId"], skipUpdateIfNoValuesChanged: false },
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      "[model-keys] could not record API key health:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** The health rows of these AI Models' keys. */
export async function listKeyHealth(modelIds: readonly string[]): Promise<AIModelKeyHealth[]> {
  if (modelIds.length === 0) return [];
  return AppDataSource.getRepository(AIModelKeyHealth).find({
    where: { modelId: In([...modelIds]) },
  });
}

function forgetMemory(modelId: string, keep: ReadonlySet<string> = new Set()): void {
  for (const memory of [rests, lastUsedWrites]) {
    for (const entry of memory.keys()) {
      if (modelOf(entry) === modelId && !keep.has(entry.slice(modelId.length + 1))) {
        memory.delete(entry);
      }
    }
  }
}

/**
 * Drop the health of every key this AI Model no longer holds — after a key is
 * removed or replaced, or its provider changed and took the keys with it.
 */
export async function pruneKeyHealth(
  model: Pick<AIModel, "id" | "configJson">,
  manager: EntityManager = AppDataSource.manager,
): Promise<void> {
  const live = readApiKeys(model.configJson).map((key) => key.id);
  await manager.delete(
    AIModelKeyHealth,
    live.length === 0 ? { modelId: model.id } : { modelId: model.id, keyId: Not(In(live)) },
  );
  forgetMemory(model.id, new Set(live));
}

/** Drop every key's health for these AI Models, which are being deleted. */
export async function deleteKeyHealth(
  modelIds: readonly string[],
  manager: EntityManager = AppDataSource.manager,
): Promise<void> {
  if (modelIds.length === 0) return;
  await manager.delete(AIModelKeyHealth, { modelId: In([...modelIds]) });
  for (const modelId of modelIds) forgetMemory(modelId);
}

/** Tests only: forget every rest and write throttle held in memory. */
export function resetKeyHealthMemory(): void {
  rests.clear();
  lastUsedWrites.clear();
}
