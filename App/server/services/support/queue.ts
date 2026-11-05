import { In, LessThan, LessThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { SupportJob } from "../../db/entities/SupportJob.js";
import type { SupportJobKind } from "../../../shared/support.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { onModelAvailabilityChange } from "../modelAvailability.js";

/**
 * Everything Support does in the background, as rows.
 *
 * Two lanes, because the work in them is nothing alike. Bringing an email in is
 * a few database writes and must never queue behind a model turn: a ticket
 * appearing is the product. AI work takes minutes and a provider's patience.
 *
 * A job is claimed with a conditional update from `queued` to `running`, which
 * exactly one process wins; one whose process died goes back in line. Retries
 * follow the Data room queue's rules: a Standdown or an unavailable AI Model is
 * waiting, not failing, and spends no attempt; a timeout or a provider error
 * tries again after a growing pause; and something only a person can fix fails
 * at once and says so on the ticket.
 */

export const MAX_JOB_ATTEMPTS = 3;
export const STALE_RUNNING_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const STANDDOWN_RECHECK_MS = 5 * 60_000;
const MODEL_UNAVAILABLE_RECHECK_MS = 60_000;
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Quick work the product's freshness depends on. */
const FAST_KINDS: SupportJobKind[] = [
  "intake",
  "import",
  "acknowledge",
  "rating",
  "chat_confirm",
  "chat_email",
];
/** Model turns. */
const AI_KINDS: SupportJobKind[] = ["work", "article", "insights"];
const LANE_CONCURRENCY = { fast: 3, ai: 3 } as const;
type Lane = keyof typeof LANE_CONCURRENCY;

export type SupportJobOutcome =
  | { outcome: "done" }
  /** Not finished and nothing wrong: look again later, spending no attempt. */
  | { outcome: "again"; delayMs: number }
  /** Worth another try later: nothing is wrong with the setup. */
  | {
      outcome: "retry";
      cause: "standdown" | "model_unavailable" | "model_busy" | "timeout" | "error";
      detail: string;
    }
  /** A person must change something before the job can succeed. */
  | { outcome: "failed"; detail: string };

const active: Record<Lane, number> = { fast: 0, ai: 0 };
const draining: Record<Lane, boolean> = { fast: false, ai: false };
let autoKick = true;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let unsubscribe: (() => void) | null = null;

/** Tests drive the queue by hand with {@link runSupportQueueOnce}. */
export function setSupportQueueAutoKickForTests(enabled: boolean): void {
  autoKick = enabled;
}

/**
 * Queue work. A job already waiting for the same thing is kept rather than
 * doubled; an older finished or failed one is cleared so a ticket shows only its
 * newest attempt.
 */
export async function enqueueSupportJob(args: {
  companyId: string;
  kind: SupportJobKind;
  targetId: string;
  ticketId?: string | null;
  delayMs?: number;
  requestedByUserId?: string | null;
}): Promise<SupportJob> {
  const repo = AppDataSource.getRepository(SupportJob);
  const waiting = await repo.findOneBy({
    companyId: args.companyId,
    kind: args.kind,
    targetId: args.targetId,
    status: "queued",
  });
  if (waiting) {
    // A Member asking is a reason to go now, and to allow what asking allows.
    if (args.requestedByUserId && !waiting.requestedByUserId) {
      await repo.update(
        { id: waiting.id },
        { requestedByUserId: args.requestedByUserId, runAfter: new Date() },
      );
    }
    kick();
    return waiting;
  }
  await repo.delete({
    companyId: args.companyId,
    kind: args.kind,
    targetId: args.targetId,
    status: In(["done", "failed"]),
  });
  const job = await repo.save(
    repo.create({
      companyId: args.companyId,
      kind: args.kind,
      targetId: args.targetId,
      ticketId: args.ticketId ?? null,
      status: "queued",
      attempts: 0,
      runAfter: new Date(Date.now() + (args.delayMs ?? 0)),
      startedAt: null,
      finishedAt: null,
      error: "",
      requestedByUserId: args.requestedByUserId ?? null,
    }),
  );
  await announce(job);
  if (args.delayMs) kickAt(args.delayMs);
  else kick();
  return job;
}

export async function cancelSupportJobs(where: {
  companyId: string;
  kind?: SupportJobKind;
  targetId: string;
}): Promise<void> {
  await AppDataSource.getRepository(SupportJob).delete(where);
}

async function announce(job: Pick<SupportJob, "companyId" | "ticketId">): Promise<void> {
  if (!job.ticketId) return;
  const { announceTicket } = await import("./access.js");
  announceTicket({ id: job.ticketId, companyId: job.companyId });
}

function kick(): void {
  if (!autoKick) return;
  for (const lane of ["fast", "ai"] as Lane[]) {
    setImmediate(() => {
      void drain(lane).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[support] ${lane} queue failed:`, err);
      });
    });
  }
}

/** Wake when a delayed job comes due, so it does not wait for the next sweep. */
function kickAt(delayMs: number): void {
  if (!autoKick) return;
  const timer = setTimeout(kick, delayMs + 25);
  timer.unref();
}

function laneKinds(lane: Lane | null): SupportJobKind[] {
  if (lane === "fast") return FAST_KINDS;
  if (lane === "ai") return AI_KINDS;
  return [...FAST_KINDS, ...AI_KINDS];
}

async function claimNext(lane: Lane | null): Promise<SupportJob | null> {
  const repo = AppDataSource.getRepository(SupportJob);
  for (let tries = 0; tries < 5; tries++) {
    const next = await repo.findOne({
      where: {
        status: "queued",
        runAfter: LessThanOrEqual(new Date()),
        kind: In(laneKinds(lane)),
      },
      order: { runAfter: "ASC" },
    });
    if (!next) return null;
    const claim = await repo
      .createQueryBuilder()
      .update(SupportJob)
      .set({ status: "running", startedAt: new Date(), attempts: next.attempts + 1 })
      .where("id = :id", { id: next.id })
      .andWhere("status = :queued", { queued: "queued" })
      .execute();
    if (claim.affected === 1) {
      next.status = "running";
      next.attempts += 1;
      await announce(next);
      return next;
    }
  }
  return null;
}

async function drain(lane: Lane): Promise<void> {
  if (draining[lane]) return;
  draining[lane] = true;
  try {
    while (active[lane] < LANE_CONCURRENCY[lane]) {
      const claimed = await claimNext(lane);
      if (!claimed) break;
      active[lane] += 1;
      void settle(claimed)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`[support] job ${claimed.id} failed to settle:`, err);
        })
        .finally(() => {
          active[lane] -= 1;
          kick();
        });
    }
  } finally {
    draining[lane] = false;
  }
}

/** Run one job. The runners load here, so modules that queue work never load the AI runtime. */
async function runJob(job: SupportJob): Promise<SupportJobOutcome> {
  switch (job.kind) {
    case "intake":
      return (await import("./intake.js")).runIntakeJob(job);
    case "import":
      return (await import("./intake.js")).runImportJob(job);
    case "acknowledge":
      return (await import("./replies.js")).runAcknowledgeJob(job);
    case "rating":
      return (await import("./ratings.js")).runRatingJob(job);
    case "chat_confirm":
      return (await import("./chatEmail.js")).runChatConfirmJob(job);
    case "chat_email":
      return (await import("./chatEmail.js")).runChatEmailJob(job);
    case "work":
    case "article":
    case "insights":
      return (await import("./ai.js")).runSupportAiJob(job);
  }
}

async function settle(job: SupportJob): Promise<SupportJobOutcome> {
  let outcome: SupportJobOutcome;
  try {
    outcome = await runJob(job);
  } catch (error) {
    outcome = {
      outcome: "retry",
      cause: "error",
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    };
  }
  const repo = AppDataSource.getRepository(SupportJob);
  if (outcome.outcome === "done") {
    await repo.update({ id: job.id }, { status: "done", finishedAt: new Date(), error: "" });
  } else if (outcome.outcome === "again") {
    await repo.update(
      { id: job.id },
      {
        status: "queued",
        runAfter: new Date(Date.now() + outcome.delayMs),
        startedAt: null,
        attempts: Math.max(0, job.attempts - 1),
        error: "",
      },
    );
    kickAt(outcome.delayMs);
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
  await announce(job);
  return outcome;
}

/** Run every job that is due, one at a time, and report each outcome. For tests. */
export async function runSupportQueueOnce(): Promise<SupportJobOutcome[]> {
  const outcomes: SupportJobOutcome[] = [];
  for (;;) {
    const claimed = await claimNext(null);
    if (!claimed) break;
    outcomes.push(await settle(claimed));
  }
  return outcomes;
}

async function sweepQueue(): Promise<void> {
  const repo = AppDataSource.getRepository(SupportJob);
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

async function sweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweepQueue();
    await withSchedulerLease("support-sweep", 5 * 60_000, async () => {
      const { runSupportSweep } = await import("./sweep.js");
      await runSupportSweep();
    });
  } finally {
    sweeping = false;
  }
}

/**
 * Pick the queue up after a restart and keep it moving: deferred and retried
 * jobs come due on the sweep, which also runs the ticket clocks. AI work that
 * waited on a model goes as soon as it answers, rather than at the next look.
 */
export function bootSupportQueue(): void {
  if (sweepTimer) return;
  void sweep().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[support] recovery failed:", err);
  });
  sweepTimer = setInterval(() => {
    void sweep().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[support] sweep failed:", err);
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  unsubscribe?.();
  unsubscribe = onModelAvailabilityChange((change) => {
    if (!change.available) return;
    void AppDataSource.getRepository(SupportJob)
      .update({ status: "queued", kind: In(AI_KINDS) }, { runAfter: new Date() })
      .then(() => kick())
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[support] could not resume after a model came back:", err);
      });
  });
}
