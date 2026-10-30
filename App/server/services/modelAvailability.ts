import { IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { AIModelOutage, type AIModelOutageRecovery } from "../db/entities/AIModelOutage.js";
import type { ModelUnavailability, ModelUnavailableCause } from "./agent/modelOutage.js";
import { modelRunCapacity } from "./modelRunCapacity.js";
import { emitResourceChange } from "./resourceEvents.js";
import { getModelAvailabilitySettings } from "./runtimeSettings.js";
import type { RuntimeModelAvailabilitySettings } from "./runtimeSettings.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/**
 * Whether each AI Model is available right now — a circuit breaker, shared by
 * every AI Employee the model is attached to.
 *
 * An AI Model's service goes down: a hosted API has an incident or is
 * overloaded, a self-hosted server restarts or crashes, every key is
 * rate-limited. Work sent to it then fails, and used to fail for good — a Run
 * ended as an Error, its retry spent, its employee's waivers revoked, a page
 * sent; a chat message came back as a wall of error text. None of that was
 * true: nothing about the work was wrong, and it would have succeeded an hour
 * later. So AI work now **waits** for an unavailable model and carries on when
 * it is back.
 *
 * The states, per model (keyed as `modelRunCapacity` keys it — the AIModel
 * row, or the endpoint for a custom model — within one company):
 *
 *   - **Available.** Work starts as usual. Every request that fails with an
 *     outage (`services/agent/modelOutage.ts`) counts toward a run of failures;
 *     any success resets it.
 *   - **Unavailable**, after `failureThreshold` failures in a row, one failure
 *     that is unavailable on its face (a refused connection, an unknown host, a
 *     refused certificate), or a turn that ran out of retries on one. The queue
 *     starts none of the model's Runs, a Run that meets the outage pauses as
 *     itself (`runPause.ts`), a chat message waits to be answered, and
 *     background work defers. A cheap check (`modelAvailabilityProbe.ts`) asks
 *     the model again — one at a time, on a backoff that doubles from
 *     `firstCheckSeconds` up to `maxCheckIntervalMinutes`, with jitter, and
 *     never sooner than a `retry-after` the service asked for.
 *   - **Available again** when a check or real work succeeds. The Runs that
 *     waited start again, paused ones first with the time they had left, one
 *     every `resumeIntervalSeconds` for a while so they do not all land at once.
 *
 * The state is a database row per outage (`AIModelOutage`), so it survives a
 * restart, every replica sees it, and owners and admins are told once when a
 * check confirms an outage and once when it ends — never once per Run.
 *
 * This is not a Standdown. A Standdown is a person's decision to stop work;
 * an outage is nobody's decision, records no verdict, failure, journal entry,
 * alert or autonomy change, and lifts itself. The two compose: a Standdown
 * placed during an outage still defers the work, recovery never starts work a
 * Standdown covers, and lifting a Standdown never starts work on a model that
 * is still unavailable — the queue checks both.
 */

/** The fields of an AI Model this module reads. */
export type AvailabilityModel = Pick<
  AIModel,
  "id" | "companyId" | "provider" | "authMode" | "configJson" | "maxConcurrentRuns" | "model"
>;

/** What one check found. `unknown` means it could not ask — no usable credential, a busy sign-in. */
export type ModelCheckOutcome =
  | { kind: "available" }
  | { kind: "unavailable"; unavailability: ModelUnavailability }
  | { kind: "unknown"; reason: string };

export type ModelAvailabilityState =
  | { available: true }
  | {
      available: false;
      since: Date;
      cause: ModelUnavailableCause;
      detail: string;
      /** Checks that found it still unavailable. */
      checks: number;
      lastCheckedAt: Date | null;
      nextCheckAt: Date;
      /** A check is asking the model right now. */
      checking: boolean;
    };

export type ModelAvailabilityChange = {
  key: string;
  companyId: string;
  modelId: string;
  available: boolean;
};

/** How long Runs that waited keep starting one at a time after a model is back. */
export const RECOVERY_RAMP_MS = 10 * 60_000;
/** The longest `retry-after` a check honours; past it the backoff decides. */
export const MAX_HONOURED_RETRY_AFTER_MS = 60 * 60_000;
/** Each wait is jittered by up to this fraction either way, so replicas and models drift apart. */
export const CHECK_JITTER = 0.2;
/** How often every replica re-reads the open outages, so a recovery anywhere reaches all. */
const SYNC_INTERVAL_MS = 15_000;
/** One replica checks a model at a time. */
const CHECK_LEASE_MS = 120_000;

type Outage = {
  /** The persisted row, once saved. */
  id: string | null;
  since: number;
  cause: ModelUnavailableCause;
  detail: string;
  status: number | null;
  checks: number;
  lastCheckedAt: number | null;
  nextCheckAt: number;
  notified: boolean;
};

type Entry = {
  key: string;
  companyId: string;
  /** The AI Model whose credentials a check uses. */
  modelId: string;
  failures: number;
  streakSince: number | null;
  outage: Outage | null;
  timer: ReturnType<typeof setTimeout> | null;
  checking: Promise<void> | null;
  /** Until when Runs start one at a time after a recovery, and when the next may. */
  rampUntil: number;
  nextAdmitAt: number;
  /** Database writes for this model, one after another. */
  writes: Promise<void>;
};

const entries = new Map<string, Entry>();
const listeners = new Set<(change: ModelAvailabilityChange) => void>();
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncing: Promise<void> | null = null;
let checkOverride: ((model: AIModel) => Promise<ModelCheckOutcome>) | null = null;
let random: () => number = Math.random;

/** The company-scoped identity a model's availability is kept under. */
export function availabilityKey(companyId: string, capacityKey: string): string {
  return `${companyId}:${capacityKey}`;
}

/** {@link availabilityKey} for a model row. Decrypts a custom endpoint's address. */
export function modelAvailabilityKey(model: AvailabilityModel): string {
  return availabilityKey(model.companyId, modelRunCapacity(model).key);
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.info(`[model-availability] ${message}`);
}

function warn(message: string, error?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[model-availability] ${message}`, ...(error === undefined ? [] : [error]));
}

function entryFor(key: string, companyId: string, modelId: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      companyId,
      modelId,
      failures: 0,
      streakSince: null,
      outage: null,
      timer: null,
      checking: null,
      rampUntil: 0,
      nextAdmitAt: 0,
      writes: Promise.resolve(),
    };
    entries.set(key, entry);
  }
  return entry;
}

function write(entry: Entry, what: string, fn: () => Promise<void>): void {
  entry.writes = entry.writes.then(fn).catch((error) => warn(`could not save ${what}:`, error));
}

function announce(entry: Entry, available: boolean): void {
  // AI Models live under the "employee" resource kind; open AI Models pages
  // refresh. Never a Routine Trigger: an outage is not a company event.
  emitResourceChange(entry.companyId, "employee", undefined, { trigger: false });
  emitResourceChange(entry.companyId, "run", undefined, { trigger: false });
  const change = { key: entry.key, companyId: entry.companyId, modelId: entry.modelId, available };
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (error) {
      warn("a listener failed:", error);
    }
  }
}

/** The wait before check number `checks + 1`: doubling from the first, capped, with jitter. */
export function nextCheckDelayMs(
  checks: number,
  settings: Pick<RuntimeModelAvailabilitySettings, "firstCheckSeconds" | "maxCheckIntervalMinutes">,
  rand: () => number = random,
): number {
  const base = settings.firstCheckSeconds * 1000;
  const cap = Math.max(base, settings.maxCheckIntervalMinutes * 60_000);
  const delay = Math.min(cap, base * 2 ** Math.min(Math.max(0, checks), 30));
  const factor = 1 - CHECK_JITTER + 2 * CHECK_JITTER * Math.min(1, Math.max(0, rand()));
  return Math.round(delay * factor);
}

function checkDelayMs(checks: number, retryAfterMs: number | null): number {
  const backoff = nextCheckDelayMs(checks, getModelAvailabilitySettings());
  const asked = retryAfterMs === null ? 0 : Math.min(retryAfterMs, MAX_HONOURED_RETRY_AFTER_MS);
  return Math.max(backoff, asked);
}

function schedule(entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  const outage = entry.outage;
  if (!outage) return;
  entry.timer = setTimeout(
    () => {
      entry.timer = null;
      void runCheck(entry).catch((error) => warn("a check failed:", error));
    },
    Math.max(0, outage.nextCheckAt - Date.now()),
  );
  entry.timer.unref?.();
}

/** Whether work may be sent to this model now. Cheap: memory only. */
export function isModelAvailable(model: AvailabilityModel): boolean {
  if (entries.size === 0) return true;
  return !entries.get(modelAvailabilityKey(model))?.outage;
}

/** {@link isModelAvailable} for an availability key already computed. */
export function isKeyAvailable(key: string): boolean {
  return !entries.get(key)?.outage;
}

/** Whether any model of this company is unavailable right now. Memory only. */
export function companyHasUnavailableModel(companyId: string): boolean {
  for (const entry of entries.values()) {
    if (entry.companyId === companyId && entry.outage) return true;
  }
  return false;
}

function stateOf(entry: Entry | undefined): ModelAvailabilityState {
  const outage = entry?.outage;
  if (!entry || !outage) return { available: true };
  return {
    available: false,
    since: new Date(outage.since),
    cause: outage.cause,
    detail: outage.detail,
    checks: outage.checks,
    lastCheckedAt: outage.lastCheckedAt === null ? null : new Date(outage.lastCheckedAt),
    nextCheckAt: new Date(outage.nextCheckAt),
    checking: entry.checking !== null,
  };
}

/** The model's availability, for the AI Models page and System Health. */
export function modelAvailabilityState(model: AvailabilityModel): ModelAvailabilityState {
  if (entries.size === 0) return { available: true };
  return stateOf(entries.get(modelAvailabilityKey(model)));
}

export type ModelWorkGate =
  | { gate: "open" }
  | { gate: "unavailable"; state: Extract<ModelAvailabilityState, { available: false }> }
  /** Back, but still starting the Runs that waited one at a time; the next may start at `at`. */
  | { gate: "paced"; at: number };

/** Whether the Routine queue may start a Run on the model with this key now. */
export function keyWorkGate(key: string, now: number = Date.now()): ModelWorkGate {
  const entry = entries.get(key);
  if (!entry) return { gate: "open" };
  const state = stateOf(entry);
  if (!state.available) return { gate: "unavailable", state };
  if (now < entry.rampUntil && now < entry.nextAdmitAt) return { gate: "paced", at: entry.nextAdmitAt };
  return { gate: "open" };
}

/** A Run just started on this model: while it is recovering, the next waits its turn. */
export function noteKeyWorkStarted(key: string, now: number = Date.now()): void {
  const entry = entries.get(key);
  if (!entry || now >= entry.rampUntil) return;
  const spacing = getModelAvailabilitySettings().resumeIntervalSeconds * 1000;
  entry.nextAdmitAt = now + spacing;
}

/**
 * A request to this model succeeded: the run of failures ends, and an outage
 * — if it was unavailable — is over. Memory only, unless that ends an outage.
 */
export function recordModelSuccess(model: AvailabilityModel): void {
  if (entries.size === 0) return;
  recordKeySuccess(modelAvailabilityKey(model));
}

/** {@link recordModelSuccess} for an availability key already computed. */
export function recordKeySuccess(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.failures = 0;
  entry.streakSince = null;
  if (entry.outage) recover(entry, "traffic");
}

/**
 * A request to this model failed with an outage. Returns whether the model is
 * now unavailable. `terminal` is a turn that already spent its runtime's
 * retries on the outage — enough on its own.
 */
export function recordModelFailure(
  model: AvailabilityModel,
  unavailability: ModelUnavailability,
  options: { terminal?: boolean } = {},
): boolean {
  return recordKeyFailure(
    modelAvailabilityKey(model),
    { companyId: model.companyId, modelId: model.id },
    unavailability,
    options,
  );
}

/** {@link recordModelFailure} for an availability key already computed. */
export function recordKeyFailure(
  key: string,
  owner: { companyId: string; modelId: string },
  unavailability: ModelUnavailability,
  options: { terminal?: boolean } = {},
): boolean {
  const entry = entryFor(key, owner.companyId, owner.modelId);
  const now = Date.now();
  if (entry.outage) {
    // Already unavailable: the newest words, the same outage.
    entry.outage.detail = unavailability.detail;
    entry.outage.cause = unavailability.cause;
    entry.outage.status = unavailability.status;
    return true;
  }
  entry.failures += 1;
  entry.streakSince ??= now;
  const threshold = getModelAvailabilitySettings().failureThreshold;
  if (options.terminal || unavailability.definite || entry.failures >= threshold) {
    entry.modelId = owner.modelId;
    trip(entry, unavailability, now);
    return true;
  }
  return false;
}

function trip(entry: Entry, unavailability: ModelUnavailability, now: number): void {
  const outage: Outage = {
    id: null,
    since: entry.streakSince ?? now,
    cause: unavailability.cause,
    detail: unavailability.detail,
    status: unavailability.status,
    checks: 0,
    lastCheckedAt: null,
    nextCheckAt: now + checkDelayMs(0, unavailability.retryAfterMs),
    notified: false,
  };
  entry.outage = outage;
  entry.failures = 0;
  entry.streakSince = null;
  entry.rampUntil = 0;
  log(`${entry.key} is unavailable: ${unavailability.detail}`);
  schedule(entry);
  write(entry, "an outage", () => persistTrip(entry, outage));
  announce(entry, false);
}

async function persistTrip(entry: Entry, outage: Outage): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  const repo = AppDataSource.getRepository(AIModelOutage);
  const adopt = (open: AIModelOutage) => {
    outage.id = open.id;
    outage.since = Math.min(outage.since, open.startedAt.getTime());
    outage.notified = open.notifiedAt !== null;
  };
  const open = await repo.findOneBy({ key: entry.key, endedAt: IsNull() });
  if (open) {
    adopt(open);
    await repo.update(
      { id: open.id },
      { lastError: outage.detail.slice(0, 300), lastStatus: outage.status, cause: outage.cause },
    );
    return;
  }
  try {
    const saved = await repo.save(
      repo.create({
        key: entry.key,
        companyId: entry.companyId,
        modelId: entry.modelId,
        startedAt: new Date(outage.since),
        endedAt: null,
        recoveredBy: null,
        cause: outage.cause,
        lastError: outage.detail.slice(0, 300),
        lastStatus: outage.status,
        checks: 0,
        lastCheckedAt: null,
        nextCheckAt: new Date(outage.nextCheckAt),
        notifiedAt: null,
      }),
    );
    outage.id = saved.id;
  } catch (error) {
    // Another replica opened it first: one outage, one row.
    const raced = await repo.findOneBy({ key: entry.key, endedAt: IsNull() });
    if (!raced) throw error;
    adopt(raced);
  }
}

function recover(entry: Entry, how: AIModelOutageRecovery, options: { persist?: boolean } = {}): void {
  const outage = entry.outage;
  if (!outage) return;
  const now = Date.now();
  entry.outage = null;
  entry.failures = 0;
  entry.streakSince = null;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (getModelAvailabilitySettings().resumeIntervalSeconds > 0) {
    entry.rampUntil = now + RECOVERY_RAMP_MS;
    entry.nextAdmitAt = now;
  }
  const minutes = Math.max(1, Math.round((now - outage.since) / 60_000));
  log(`${entry.key} is available again after about ${minutes} min (${how}).`);
  if (options.persist !== false) write(entry, "a recovery", () => persistRecovery(entry, outage, how, now));
  announce(entry, true);
}

async function persistRecovery(
  entry: Entry,
  outage: Outage,
  how: AIModelOutageRecovery,
  now: number,
): Promise<void> {
  if (!outage.id || !AppDataSource.isInitialized) return;
  const repo = AppDataSource.getRepository(AIModelOutage);
  const closed = await repo.update(
    { id: outage.id, endedAt: IsNull() },
    { endedAt: new Date(now), recoveredBy: how },
  );
  if (closed.affected !== 1 || how === "removed") return;
  const row = await repo.findOneBy({ id: outage.id });
  if (!row?.notifiedAt) return;
  const { notifyModelAvailableAgain } = await import("./modelOutageAlerts.js");
  await notifyModelAvailableAgain(row);
}

async function persistCheck(entry: Entry, outage: Outage): Promise<void> {
  if (!outage.id || !AppDataSource.isInitialized) return;
  const repo = AppDataSource.getRepository(AIModelOutage);
  await repo.update(
    { id: outage.id, endedAt: IsNull() },
    {
      checks: outage.checks,
      lastCheckedAt: outage.lastCheckedAt === null ? null : new Date(outage.lastCheckedAt),
      nextCheckAt: new Date(outage.nextCheckAt),
      lastError: outage.detail.slice(0, 300),
      lastStatus: outage.status,
      cause: outage.cause,
    },
  );
  if (outage.checks < 1 || outage.notified) return;
  // Confirmed by a check of its own, not only by the work that failed: tell
  // the owners and admins, once for this outage.
  const claim = await repo.update(
    { id: outage.id, notifiedAt: IsNull(), endedAt: IsNull() },
    { notifiedAt: new Date() },
  );
  outage.notified = true;
  if (claim.affected !== 1) return;
  const row = await repo.findOneBy({ id: outage.id });
  if (!row) return;
  const { notifyModelUnavailable } = await import("./modelOutageAlerts.js");
  await notifyModelUnavailable(row);
}

/** The AI Model a check of this outage uses: the one that failed, or another on the same endpoint. */
async function modelForCheck(entry: Entry): Promise<AIModel | null> {
  const repo = AppDataSource.getRepository(AIModel);
  const own = await repo.findOneBy({ id: entry.modelId, companyId: entry.companyId });
  if (own && modelAvailabilityKey(own) === entry.key) return own;
  const company = await repo.find({ where: { companyId: entry.companyId } });
  const other = company.find((candidate) => {
    try {
      return modelAvailabilityKey(candidate) === entry.key;
    } catch {
      return false;
    }
  });
  if (other) entry.modelId = other.id;
  return other ?? null;
}

async function askModel(model: AIModel): Promise<ModelCheckOutcome> {
  if (checkOverride) return checkOverride(model);
  const { checkModel } = await import("./modelAvailabilityProbe.js");
  return checkModel(model);
}

/** Ask an unavailable model whether it answers again. One check per model at a time. */
function runCheck(entry: Entry): Promise<void> {
  if (entry.checking) return entry.checking;
  entry.checking = (async () => {
    try {
      if (!entry.outage) return;
      if (!AppDataSource.isInitialized) {
        // Nothing to read a model from; try again on the same schedule.
        entry.outage.nextCheckAt = Date.now() + checkDelayMs(entry.outage.checks, null);
        return;
      }
      const ran = await withSchedulerLease(
        `model-availability-check:${entry.key}`,
        CHECK_LEASE_MS,
        async () => {
          const model = await modelForCheck(entry);
          if (!entry.outage) return;
          if (!model) {
            // Its model is gone, and no other on the same endpoint is left to
            // check with: nothing waits on it any more.
            recover(entry, "removed");
            return;
          }
          const outcome = await askModel(model).catch(
            (error): ModelCheckOutcome => ({
              kind: "unknown",
              reason: error instanceof Error ? error.name : "check failed",
            }),
          );
          applyCheck(entry, outcome);
        },
      );
      if (ran === null && entry.outage) {
        // Another replica is checking; its result reaches here through the
        // database. Look again soon rather than at the next backoff step.
        entry.outage.nextCheckAt = Date.now() + nextCheckDelayMs(0, getModelAvailabilitySettings());
      }
    } finally {
      entry.checking = null;
      if (entry.outage) schedule(entry);
    }
  })();
  return entry.checking;
}

function applyCheck(entry: Entry, outcome: ModelCheckOutcome): void {
  const outage = entry.outage;
  if (!outage) return;
  const now = Date.now();
  if (outcome.kind === "available") {
    recover(entry, "check");
    return;
  }
  if (outcome.kind === "unknown") {
    outage.nextCheckAt = now + checkDelayMs(outage.checks, null);
    log(`${entry.key} could not be checked (${outcome.reason}); checking again later.`);
    write(entry, "a check", () => persistCheck(entry, outage));
    return;
  }
  const { unavailability } = outcome;
  outage.checks += 1;
  outage.lastCheckedAt = now;
  outage.detail = unavailability.detail;
  outage.cause = unavailability.cause;
  outage.status = unavailability.status;
  outage.nextCheckAt = now + checkDelayMs(outage.checks, unavailability.retryAfterMs);
  log(
    `${entry.key} is still unavailable after check ${outage.checks}: ${unavailability.detail} ` +
      `Next check at ${new Date(outage.nextCheckAt).toISOString()}.`,
  );
  write(entry, "a check", () => persistCheck(entry, outage));
  emitResourceChange(entry.companyId, "employee", undefined, { trigger: false });
}

/**
 * Check an unavailable model now — "Check now" on the AI Models page — and
 * return what it found. An available model has nothing to check.
 */
export async function checkModelAvailabilityNow(
  model: AvailabilityModel,
): Promise<ModelAvailabilityState> {
  const key = modelAvailabilityKey(model);
  const entry = entries.get(key);
  if (!entry?.outage) return { available: true };
  entry.modelId = model.id;
  await runCheck(entry);
  await entry.writes;
  return stateOf(entry);
}

/** Hear when a model becomes unavailable or available again. Returns the unsubscribe. */
export function onModelAvailabilityChange(
  listener: (change: ModelAvailabilityChange) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Bring this process in line with the outages in the database: adopt one
 * another replica (or the process before a restart) opened, and let go of one
 * another replica saw end. Called at boot and every few seconds after.
 */
export async function loadModelOutages(): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  const rows = await AppDataSource.getRepository(AIModelOutage).find({
    where: { endedAt: IsNull() },
  });
  const open = new Set<string>();
  for (const row of rows) {
    open.add(row.key);
    const entry = entryFor(row.key, row.companyId, row.modelId);
    if (entry.outage) {
      entry.outage.id ??= row.id;
      if (row.notifiedAt) entry.outage.notified = true;
      continue;
    }
    entry.outage = {
      id: row.id,
      since: row.startedAt.getTime(),
      cause: row.cause,
      detail: row.lastError,
      status: row.lastStatus,
      checks: row.checks,
      lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
      nextCheckAt: row.nextCheckAt.getTime(),
      notified: row.notifiedAt !== null,
    };
    entry.failures = 0;
    entry.streakSince = null;
    schedule(entry);
    announce(entry, false);
  }
  for (const entry of entries.values()) {
    // Ended elsewhere — another replica's check, or real work there. Its
    // replica already told people; this one only lets the work go.
    if (entry.outage?.id && !open.has(entry.key) && !entry.checking) {
      recover(entry, "check", { persist: false });
    }
  }
}

/** Boot: adopt open outages, then keep in step with the database. */
export async function startModelAvailabilityWatcher(): Promise<void> {
  await loadModelOutages().catch((error) => warn("could not load open outages:", error));
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (syncing) return;
    syncing = loadModelOutages()
      .catch((error) => warn("could not read open outages:", error))
      .finally(() => {
        syncing = null;
      });
  }, SYNC_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopModelAvailabilityWatcher(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  for (const entry of entries.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/**
 * Forget every model's state in this process — a restore is replacing the
 * database the outages live in; {@link startModelAvailabilityWatcher} reads
 * the restored ones back.
 */
export function forgetModelAvailability(): void {
  stopModelAvailabilityWatcher();
  entries.clear();
}

/** Test seam: wait for every database write this module has started. */
export async function flushModelAvailabilityWrites(): Promise<void> {
  await Promise.all([...entries.values()].map((entry) => entry.writes));
  await Promise.all(
    [...entries.values()].map((entry) => entry.checking ?? Promise.resolve()),
  );
  await Promise.all([...entries.values()].map((entry) => entry.writes));
}

/** Test seam: what a check finds, instead of asking the model's service. */
export function setModelCheckForTests(
  check: ((model: AIModel) => Promise<ModelCheckOutcome>) | null,
): void {
  checkOverride = check;
}

/** Test seam: the jitter's random source. */
export function setAvailabilityRandomForTests(source: (() => number) | null): void {
  random = source ?? Math.random;
}

/** Test seam: forget every model's state (listeners stay registered). */
export function resetModelAvailabilityForTests(): void {
  stopModelAvailabilityWatcher();
  entries.clear();
  checkOverride = null;
  random = Math.random;
}
