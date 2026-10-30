import { randomUUID } from "node:crypto";
import { In, LessThan, LessThanOrEqual, Not } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIModelWait, type AIModelWaitKind } from "../db/entities/AIModelWait.js";
import {
  isModelAvailable,
  modelAvailabilityState,
  onModelAvailabilityChange,
} from "./modelAvailability.js";
import { resolveChatModel } from "./models.js";

/**
 * AI work that waits for an unavailable AI Model and has no queue of its own
 * to wait in — and carries on by itself, once, when the model answers again.
 *
 * `services/modelAvailability.ts` says whether a model is available. The work
 * that meets one that is not either waits where it already lives (a Run in the
 * Routine queue, a chat message in its conversation) or, when there is no such
 * place, the feature marks its own row (an email "waiting", a Pipeline run
 * "paused", a Decision's pickup "waiting") and calls {@link waitForModel},
 * which adds one {@link AIModelWait}. This module resumes those:
 *
 *   - **When.** At once when any AI Model becomes available again
 *     (`onModelAvailabilityChange`), and on a slow sweep for what that missed —
 *     another replica's recovery, a wait added while the model was already
 *     back. A wait whose own model is still unavailable is skipped without
 *     touching the feature, so lifting a Standdown or a sweep never starts work
 *     on a model that is down.
 *   - **Once.** A wait is claimed (`waiting` → `resuming`) before its work
 *     starts, the claim is renewed while it runs and lapses if its process
 *     dies, and the row is deleted when the work ran. The feature's own claim
 *     on its row (a reply's, a run's, a Decision's) is the second guard.
 *   - **Through the feature.** Each kind's {@link ModelWaitHandler} lives beside
 *     the feature and re-runs its rules at the moment the work runs — Grants,
 *     Standdowns, delivery limits, who will read the answer — so a wait never
 *     carries a decision made while the model was down.
 *   - **Bounded.** A handler may give work a maximum age (an answer owed on
 *     WhatsApp has 24 hours), and work that meets the model unavailable
 *     {@link MAX_WAIT_ATTEMPTS} times after resuming is given up, the feature
 *     saying why. Each kind resumes a few at a time, so a recovery is not a
 *     burst.
 *
 * Like a paused Run, a wait records no verdict, failure, journal entry, alert
 * or retry: nobody decided the work should stop.
 */

/** What a handler's resume came to. */
export type ModelWaitResult =
  /** It ran — or the feature's own rules say it never will, and the feature recorded why. */
  | { status: "done" }
  /** It met the AI Model unavailable again: it waits, and the attempt counts. */
  | { status: "waiting" }
  /** Not ready for a reason that is not the model (a mailbox paused): look again then. */
  | { status: "later"; at: Date };

export type ModelWaitHandler = {
  /**
   * The AI Model the work would run on now. Null leaves the decision to
   * {@link resume}, which knows what having no model means for the feature.
   * Defaults to the wait's AI Employee's chat model.
   */
  model?: (wait: AIModelWait) => Promise<AIModel | null>;
  resume: (wait: AIModelWait) => Promise<ModelWaitResult>;
  /** The longest the work may wait, from when it began to; null or absent is no limit. */
  maxAgeMs?: (wait: AIModelWait) => number | null;
  /** Record on the feature's row that the work will not run: too old, or too many outages. */
  abandon: (wait: AIModelWait, reason: ModelWaitAbandonReason) => Promise<void>;
  /** How many of this kind one process carries on at once. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
};

export type ModelWaitAbandonReason = "expired" | "attempts";

/** Waits of one kind carried on at once in one process. */
const DEFAULT_CONCURRENCY = 3;
/** Resumes that meet the model unavailable again before the work is given up. */
export const MAX_WAIT_ATTEMPTS = 10;
/** How long a claim lasts without renewal, and how often it is renewed. */
const CLAIM_MS = 60_000;
const CLAIM_RENEW_MS = 20_000;
/** The slow sweep, for what an availability change did not reach. */
const SWEEP_MS = 30_000;
/** The longest a waiting piece of work goes between looks. */
const LOOK_AGAIN_MS = 60_000;
/** A resume that threw — a bug, a database hiccup — is tried again after this. */
const ERROR_RETRY_MS = 5 * 60_000;
const PASS_BATCH = 100;

/**
 * Each kind's handler, loaded when first needed. Listed here rather than
 * registered by each feature, so every kind resumes whether or not its feature
 * module happens to have been imported yet, and so the features can import
 * this module to wait without a cycle.
 */
const HANDLERS: Record<AIModelWaitKind, () => Promise<ModelWaitHandler>> = {
  mail_arrival_read: async () => (await import("./mail/analysis.js")).mailArrivalReadWait,
  discussion_work: async () => (await import("./groupDiscussions.js")).discussionWorkWait,
  decision_pickup: async () => (await import("./decisionKickoff.js")).decisionPickupWait,
  decision_routing: async () => (await import("./decisionRouting.js")).decisionRoutingWait,
  pipeline_run: async () => (await import("./pipelines/executor.js")).pipelineRunWait,
  customer_channel_reply: async () =>
    (await import("./customerChannels/replies.js")).customerChannelReplyWait,
  phone_text_reply: async () => (await import("./phone/textReplies.js")).phoneTextReplyWait,
  phone_call_follow_up: async () => (await import("./phone/textReplies.js")).phoneCallFollowUpWait,
  chat_surface_reply: async () => (await import("./chatSurfaces/inbound.js")).chatSurfaceReplyWait,
};

const handlerOverrides = new Map<AIModelWaitKind, ModelWaitHandler>();
const inFlight = new Map<string, { kind: AIModelWaitKind; done: Promise<void> }>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let passing: Promise<number> | null = null;
let passAgain = false;
let started = false;

function repo() {
  return AppDataSource.getRepository(AIModelWait);
}

function log(message: string, error?: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[model-waits] ${message}`, ...(error === undefined ? [] : [error]));
}

async function handlerFor(kind: AIModelWaitKind): Promise<ModelWaitHandler | null> {
  const override = handlerOverrides.get(kind);
  if (override) return override;
  const load = HANDLERS[kind];
  if (!load) return null;
  return load();
}

export function parseWaitPayload<T>(wait: Pick<AIModelWait, "payloadJson">): Partial<T> {
  try {
    const parsed: unknown = JSON.parse(wait.payloadJson || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

function available(model: AIModel): boolean {
  try {
    return isModelAvailable(model);
  } catch {
    // A model whose address cannot be read is the feature's problem, not an outage.
    return true;
  }
}

/** When to look at work waiting on this model again: its next check, at most a minute away. */
function nextLook(model: AIModel | null, now: number): Date {
  if (!model) return new Date(now + LOOK_AGAIN_MS);
  let state;
  try {
    state = modelAvailabilityState(model);
  } catch {
    return new Date(now + LOOK_AGAIN_MS);
  }
  if (state.available) return new Date(now + LOOK_AGAIN_MS);
  const at = Math.max(state.nextCheckAt.getTime(), now + 1_000);
  return new Date(Math.min(at, now + LOOK_AGAIN_MS));
}

/**
 * When new work is first looked at: at its model's next check while the model
 * is unavailable, and at once if it has already come back by the time the
 * work began to wait.
 */
function firstLook(model: AIModel | null, now: number): Date {
  if (model && !available(model)) return nextLook(model, now);
  return new Date(now);
}

async function defaultModel(wait: AIModelWait): Promise<AIModel | null> {
  return resolveChatModel(wait.employeeId);
}

async function modelOf(handler: ModelWaitHandler, wait: AIModelWait): Promise<AIModel | null> {
  try {
    return await (handler.model ?? defaultModel)(wait);
  } catch {
    return null;
  }
}

/**
 * Record that a piece of AI work waits for its AI Model. Idempotent per
 * `(kind, targetId)`: work that meets the outage again keeps its one row, its
 * place and its count, and takes the newest payload. Returns whether this call
 * added the row — the first time this work began to wait.
 */
export async function waitForModel(args: {
  kind: AIModelWaitKind;
  targetId: string;
  companyId: string;
  employeeId: string;
  /** The AI Model it found unavailable, when known. */
  model: AIModel | null;
  groupKey?: string | null;
  payload?: unknown;
}): Promise<{ created: boolean }> {
  const payloadJson = JSON.stringify(args.payload ?? {});
  const now = Date.now();
  const resumeAt = firstLook(args.model, now);
  const id = randomUUID();
  await repo()
    .createQueryBuilder()
    .insert()
    .values({
      id,
      companyId: args.companyId,
      kind: args.kind,
      targetId: args.targetId,
      groupKey: args.groupKey ?? null,
      employeeId: args.employeeId,
      modelId: args.model?.id ?? null,
      status: "waiting",
      attempts: 0,
      resumeAt,
      claimedUntil: null,
      payloadJson,
    })
    .orIgnore()
    .execute();
  // The unique `(kind, targetId)` decides; the id says whether this call won.
  const row = await repo().findOne({
    where: { kind: args.kind, targetId: args.targetId },
    select: { id: true },
  });
  if (row?.id === id) {
    kickPass(nextDelay(resumeAt, now));
    return { created: true };
  }
  // Already waiting (or being carried on and met the outage again): the newest
  // words, the same place in line.
  await repo().update(
    { kind: args.kind, targetId: args.targetId },
    {
      payloadJson,
      employeeId: args.employeeId,
      ...(args.model ? { modelId: args.model.id } : {}),
      ...(args.groupKey !== undefined ? { groupKey: args.groupKey } : {}),
    },
  );
  return { created: false };
}

function nextDelay(resumeAt: Date, now: number): number {
  return Math.max(0, resumeAt.getTime() - now);
}

/** Forget a wait: the work was done some other way, or its row is gone. */
export async function cancelModelWait(kind: AIModelWaitKind, targetId: string): Promise<void> {
  await repo().delete({ kind, targetId, status: "waiting" });
}

/** Whether this piece of work is waiting (or being carried on) right now. */
export async function isWaitingForModel(kind: AIModelWaitKind, targetId: string): Promise<boolean> {
  return (await repo().countBy({ kind, targetId })) > 0;
}

/** The waits of one kind in one group — one conversation, thread or Pipeline. */
export async function waitsInGroup(
  kind: AIModelWaitKind,
  groupKey: string,
): Promise<AIModelWait[]> {
  return repo().find({ where: { kind, groupKey }, order: { createdAt: "ASC" } });
}

/** How many pieces of work wait on each of these models, for one company. */
export async function waitsByModel(
  companyId: string,
  modelIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(modelIds.map((id) => [id, 0]));
  if (modelIds.length === 0 || !AppDataSource.isInitialized) return counts;
  const rows = await repo()
    .createQueryBuilder("wait")
    .select("wait.modelId", "modelId")
    .addSelect("COUNT(*)", "count")
    .where("wait.companyId = :companyId", { companyId })
    .andWhere("wait.modelId IN (:...modelIds)", { modelIds: [...modelIds] })
    .groupBy("wait.modelId")
    .getRawMany<{ modelId: string; count: string | number }>();
  for (const row of rows) counts.set(row.modelId, Number(row.count) || 0);
  return counts;
}

async function releaseStaleClaims(now: Date): Promise<void> {
  const mine = [...inFlight.keys()];
  await repo().update(
    {
      status: "resuming",
      claimedUntil: LessThan(now),
      ...(mine.length ? { id: Not(In(mine)) } : {}),
    },
    { status: "waiting", claimedUntil: null, resumeAt: now },
  );
}

async function claim(wait: AIModelWait, now: Date): Promise<boolean> {
  const claimed = await repo().update(
    { id: wait.id, status: "waiting" },
    { status: "resuming", claimedUntil: new Date(now.getTime() + CLAIM_MS) },
  );
  return claimed.affected === 1;
}

async function deleteWait(wait: AIModelWait): Promise<void> {
  await repo().delete({ id: wait.id });
}

async function abandon(
  wait: AIModelWait,
  handler: ModelWaitHandler,
  reason: ModelWaitAbandonReason,
): Promise<void> {
  try {
    await handler.abandon(wait, reason);
  } catch (error) {
    log(`could not record why ${wait.kind} ${wait.targetId} stopped waiting:`, error);
  }
  await deleteWait(wait);
}

async function settle(
  wait: AIModelWait,
  handler: ModelWaitHandler,
  result: ModelWaitResult | { status: "error" },
): Promise<void> {
  const now = Date.now();
  if (result.status === "done") {
    await repo().delete({ id: wait.id, status: "resuming" });
    return;
  }
  if (result.status === "later") {
    await repo().update(
      { id: wait.id, status: "resuming" },
      { status: "waiting", claimedUntil: null, resumeAt: result.at },
    );
    return;
  }
  const attempts = wait.attempts + 1;
  if (attempts >= MAX_WAIT_ATTEMPTS) {
    const current = await repo().findOneBy({ id: wait.id });
    if (current) await abandon(current, handler, "attempts");
    return;
  }
  const resumeAt =
    result.status === "error"
      ? new Date(now + ERROR_RETRY_MS)
      : nextLook(await modelOf(handler, wait), now);
  await repo().update(
    { id: wait.id, status: "resuming" },
    { status: "waiting", claimedUntil: null, resumeAt, attempts },
  );
}

function carryOn(wait: AIModelWait, handler: ModelWaitHandler): void {
  const renew = setInterval(() => {
    void repo()
      .update(
        { id: wait.id, status: "resuming" },
        { claimedUntil: new Date(Date.now() + CLAIM_MS) },
      )
      .catch(() => undefined);
  }, CLAIM_RENEW_MS);
  renew.unref?.();
  const done = (async () => {
    let result: ModelWaitResult | { status: "error" };
    try {
      result = await handler.resume(wait);
    } catch (error) {
      log(`resuming ${wait.kind} ${wait.targetId} failed:`, error);
      result = { status: "error" };
    } finally {
      clearInterval(renew);
    }
    await settle(wait, handler, result);
  })()
    .catch((error) => log(`settling ${wait.kind} ${wait.targetId} failed:`, error))
    .finally(() => {
      inFlight.delete(wait.id);
      kickPass(0);
    });
  inFlight.set(wait.id, { kind: wait.kind, done });
}

function inFlightOf(kind: AIModelWaitKind): number {
  let count = 0;
  for (const entry of inFlight.values()) if (entry.kind === kind) count += 1;
  return count;
}

/**
 * Look at the work that is due and carry on what its AI Model can take now.
 * Returns how many pieces of work it started. Never waits for them.
 */
export async function runModelWaitsPass(now: Date = new Date()): Promise<number> {
  if (!AppDataSource.isInitialized) return 0;
  if (passing) {
    passAgain = true;
    return passing;
  }
  passing = (async () => {
    await releaseStaleClaims(now);
    const due = await repo().find({
      where: { status: "waiting", resumeAt: LessThanOrEqual(now) },
      order: { resumeAt: "ASC", id: "ASC" },
      take: PASS_BATCH,
    });
    let begun = 0;
    for (const wait of due) {
      if (inFlight.has(wait.id)) continue;
      const handler = await handlerFor(wait.kind).catch((error) => {
        log(`no way to resume ${wait.kind}:`, error);
        return null;
      });
      if (!handler) continue;
      if (inFlightOf(wait.kind) >= (handler.concurrency ?? DEFAULT_CONCURRENCY)) continue;
      const maxAge = handler.maxAgeMs?.(wait) ?? null;
      if (maxAge !== null && now.getTime() - wait.createdAt.getTime() > maxAge) {
        if (await claim(wait, now)) await abandon(wait, handler, "expired");
        continue;
      }
      const model = await modelOf(handler, wait);
      if (model && !available(model)) {
        await repo().update(
          { id: wait.id, status: "waiting" },
          { resumeAt: nextLook(model, now.getTime()) },
        );
        continue;
      }
      if (!(await claim(wait, now))) continue;
      begun += 1;
      carryOn(wait, handler);
    }
    return begun;
  })();
  try {
    return await passing;
  } finally {
    passing = null;
    if (passAgain) {
      passAgain = false;
      kickPass(0);
    }
  }
}

/**
 * Make every waiting piece of work due now — an AI Model answered again, so
 * the work waiting on it (in this company, or anywhere) is looked at at once
 * rather than at its next look. Work whose own model is still down simply
 * waits again.
 */
export async function lookAtWaitsNow(companyId?: string, at: Date = new Date()): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  await repo().update(
    { status: "waiting", ...(companyId ? { companyId } : {}) },
    { resumeAt: at },
  );
}

function kickPass(delayMs: number): void {
  if (!started) return;
  const timer = setTimeout(() => {
    void runModelWaitsPass().catch((error) => log("a pass failed:", error));
  }, delayMs);
  timer.unref?.();
}

/**
 * Boot: take back what a stopped process was carrying on, then resume work
 * whenever an AI Model answers again, with a slow sweep behind it.
 */
export async function startModelWaits(): Promise<void> {
  if (started) return;
  started = true;
  if (AppDataSource.isInitialized && config.db.driver !== "postgres") {
    // One process on SQLite: anything still marked as being carried on
    // belonged to the process before this one.
    await repo()
      .update({ status: "resuming" }, { status: "waiting", claimedUntil: null })
      .catch((error) => log("could not take back interrupted waits:", error));
  }
  unsubscribe = onModelAvailabilityChange((change) => {
    if (!change.available) return;
    void lookAtWaitsNow(change.companyId)
      .catch((error) => log("could not bring waiting work forward:", error))
      .finally(() => kickPass(0));
  });
  sweepTimer = setInterval(() => kickPass(0), SWEEP_MS);
  sweepTimer.unref?.();
  kickPass(0);
}

export function stopModelWaits(): void {
  started = false;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** Test seam: replace one kind's handler. Pass null to restore it. */
export function setModelWaitHandlerForTests(
  kind: AIModelWaitKind,
  handler: ModelWaitHandler | null,
): void {
  if (handler) handlerOverrides.set(kind, handler);
  else handlerOverrides.delete(kind);
}

/**
 * Test seam: run passes until nothing more starts and everything started has
 * settled. Work whose model is still unavailable stays waiting.
 */
export async function settleModelWaitsForTests(now?: () => Date): Promise<void> {
  await lookAtWaitsNow(undefined, now?.() ?? new Date());
  for (let i = 0; i < 50; i++) {
    const begun = await runModelWaitsPass(now?.() ?? new Date());
    const pending = [...inFlight.values()].map((entry) => entry.done);
    if (begun === 0 && pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

/** Test seam: forget handlers and timers (rows stay; tests reset the database). */
export function resetModelWaitsForTests(): void {
  stopModelWaits();
  handlerOverrides.clear();
}
