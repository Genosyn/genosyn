import { In, LessThan, LessThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { DataRoomJob } from "../../db/entities/DataRoomJob.js";
import type { DataRoomJobKind } from "../../../shared/dataRooms.js";
import { emitResourceChange } from "../resourceEvents.js";

/**
 * The queue between something happening in a data room and its AI Employee's
 * work on it: a document filed (brief it), a guest's question (draft an
 * answer), a Member asking for a readiness review or a reading of the
 * activity.
 *
 * Jobs are rows (`DataRoomJob`), so a restart loses nothing and every replica
 * can serve the queue: a job is claimed with a conditional update from
 * `queued` to `running`, which exactly one process wins, and a running job
 * whose process died is put back after {@link STALE_RUNNING_MS}.
 *
 * Retries follow the Recruiting screener's rules: a timeout, a provider error
 * or a busy subscription model tries again after a growing pause, up to
 * {@link MAX_JOB_ATTEMPTS}; a Standdown defers the job without spending an
 * attempt, because stopped work is waiting, not failing; and a room with no
 * AI Employee or no connected model fails at once, since no retry can fix what
 * only a person can. A failed job shows on the room until it is asked again.
 */

export const MAX_JOB_ATTEMPTS = 3;
export const STALE_RUNNING_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const STANDDOWN_RECHECK_MS = 5 * 60_000;
/** How soon a job whose AI Model is unavailable looks again; the look is cheap. */
const MODEL_UNAVAILABLE_RECHECK_MS = 60_000;
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CONCURRENCY = 2;

export type DataRoomJobOutcome =
  | { outcome: "done" }
  /** Worth another try later: nothing is wrong with the setup. */
  | {
      outcome: "retry";
      cause: "standdown" | "model_unavailable" | "model_busy" | "timeout" | "error";
      detail: string;
    }
  /** A person must change something before the job can succeed. */
  | { outcome: "failed"; detail: string };

let active = 0;
let draining = false;
let autoKick = true;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Tests drive the queue by hand with {@link runDataRoomQueueOnce}. */
export function setDataRoomQueueAutoKickForTests(enabled: boolean): void {
  autoKick = enabled;
}

function announce(job: Pick<DataRoomJob, "companyId" | "roomId">): void {
  // Jobs are bookkeeping: open pages refresh, and no Routine is woken for them.
  emitResourceChange(job.companyId, "data_room", job.roomId, { trigger: false });
}

/**
 * Queue AI work on one document, question or room. A job already waiting for
 * the same thing is kept rather than doubled; an older finished or failed one
 * is cleared so the room shows only the newest attempt.
 */
export async function enqueueDataRoomJob(args: {
  companyId: string;
  roomId: string;
  kind: DataRoomJobKind;
  targetId: string;
  delayMs?: number;
}): Promise<DataRoomJob> {
  const repo = AppDataSource.getRepository(DataRoomJob);
  const waiting = await repo.findOneBy({
    roomId: args.roomId,
    kind: args.kind,
    targetId: args.targetId,
    status: "queued",
  });
  if (waiting) {
    kick();
    return waiting;
  }
  await repo.delete({
    roomId: args.roomId,
    kind: args.kind,
    targetId: args.targetId,
    status: In(["done", "failed"]),
  });
  const job = await repo.save(
    repo.create({
      companyId: args.companyId,
      roomId: args.roomId,
      kind: args.kind,
      targetId: args.targetId,
      status: "queued",
      attempts: 0,
      runAfter: new Date(Date.now() + (args.delayMs ?? 0)),
      startedAt: null,
      finishedAt: null,
      error: "",
    }),
  );
  announce(job);
  kick();
  return job;
}

/** Drop every job about a document, question or room that is going away. */
export async function cancelDataRoomJobs(where: {
  roomId: string;
  targetId?: string;
}): Promise<void> {
  await AppDataSource.getRepository(DataRoomJob).delete(
    where.targetId ? { roomId: where.roomId, targetId: where.targetId } : { roomId: where.roomId },
  );
}

function kick(): void {
  if (!autoKick) return;
  setImmediate(() => {
    void drain().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[data-rooms] AI queue failed:", err);
    });
  });
}

/** Claim the oldest due job, or null when none is due. */
async function claimNext(): Promise<DataRoomJob | null> {
  const repo = AppDataSource.getRepository(DataRoomJob);
  for (let tries = 0; tries < 5; tries++) {
    const next = await repo.findOne({
      where: { status: "queued", runAfter: LessThanOrEqual(new Date()) },
      order: { runAfter: "ASC" },
    });
    if (!next) return null;
    const claim = await repo
      .createQueryBuilder()
      .update(DataRoomJob)
      .set({ status: "running", startedAt: new Date(), attempts: next.attempts + 1 })
      .where("id = :id", { id: next.id })
      .andWhere("status = :queued", { queued: "queued" })
      .execute();
    if (claim.affected === 1) {
      next.status = "running";
      next.attempts += 1;
      announce(next);
      return next;
    }
  }
  return null;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (active < CONCURRENCY) {
      const claimed = await claimNext();
      if (!claimed) break;
      active += 1;
      void settle(claimed)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`[data-rooms] job ${claimed.id} failed to settle:`, err);
        })
        .finally(() => {
          active -= 1;
          kick();
        });
    }
  } finally {
    draining = false;
  }
}

/** Run one claimed job and record what came of it. */
async function settle(job: DataRoomJob): Promise<DataRoomJobOutcome> {
  // Loaded when a job runs rather than at import, so the modules that queue
  // work never load the AI runtime — and the runners can queue work back.
  const { runDataRoomJob } = await import("./ai.js");
  let outcome: DataRoomJobOutcome;
  try {
    outcome = await runDataRoomJob(job);
  } catch (error) {
    outcome = {
      outcome: "retry",
      cause: "error",
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    };
  }
  const repo = AppDataSource.getRepository(DataRoomJob);
  if (outcome.outcome === "done") {
    await repo.update({ id: job.id }, { status: "done", finishedAt: new Date(), error: "" });
  } else if (
    outcome.outcome === "retry" &&
    (outcome.cause === "standdown" || outcome.cause === "model_unavailable")
  ) {
    // Neither is the job's fault: it waits without spending an attempt.
    await repo.update(
      { id: job.id },
      {
        status: "queued",
        runAfter: new Date(
          Date.now() +
            (outcome.cause === "standdown" ? STANDDOWN_RECHECK_MS : MODEL_UNAVAILABLE_RECHECK_MS),
        ),
        startedAt: null,
        attempts: Math.max(0, job.attempts - 1),
        error: outcome.detail,
      },
    );
  } else if (outcome.outcome === "retry" && job.attempts < MAX_JOB_ATTEMPTS) {
    await repo.update(
      { id: job.id },
      {
        status: "queued",
        runAfter: new Date(Date.now() + 60_000 * 2 ** (job.attempts - 1)),
        startedAt: null,
        error: outcome.detail,
      },
    );
  } else {
    await repo.update(
      { id: job.id },
      { status: "failed", finishedAt: new Date(), startedAt: null, error: outcome.detail },
    );
  }
  announce(job);
  return outcome;
}

/** Run every job that is due, one at a time, and report each outcome. For tests. */
export async function runDataRoomQueueOnce(): Promise<DataRoomJobOutcome[]> {
  const outcomes: DataRoomJobOutcome[] = [];
  for (;;) {
    const claimed = await claimNext();
    if (!claimed) break;
    outcomes.push(await settle(claimed));
  }
  return outcomes;
}

async function sweep(): Promise<void> {
  const repo = AppDataSource.getRepository(DataRoomJob);
  await repo.update(
    { status: "running", startedAt: LessThan(new Date(Date.now() - STALE_RUNNING_MS)) },
    { status: "queued", startedAt: null },
  );
  await repo.delete({
    status: "done",
    finishedAt: LessThan(new Date(Date.now() - FINISHED_RETENTION_MS)),
  });
  kick();
}

/**
 * Pick the queue up after a restart — jobs a dead process held go back in
 * line — and keep it moving: deferred and retried jobs come due on the sweep.
 */
export function bootDataRoomQueue(): void {
  if (sweepTimer) return;
  void sweep().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[data-rooms] queue recovery failed:", err);
  });
  sweepTimer = setInterval(() => {
    void sweep().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[data-rooms] queue sweep failed:", err);
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}
