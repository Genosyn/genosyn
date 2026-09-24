import { randomUUID } from "node:crypto";
import { IsNull, LessThanOrEqual, MoreThan, MoreThanOrEqual, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";
import { recordAudit } from "./audit.js";
import { MAX_RUN_CONTINUATIONS, readRunCheckpoint } from "./runContinuation.js";
import { StanddownError, workBlocked } from "./standdowns.js";

// Leave space for the resumed Run and every automatic continuation in the
// existing 20-Run Effects evidence window. No recovery may silently drop proof.
const MAX_RESUME_SOURCE_DEPTH = 20 - 1 - MAX_RUN_CONTINUATIONS;
const RESUME_CLAIM_MS = 5 * 60_000;
const HUMAN_REVIEW_STOP = "This work requires human review before another Run can start.";

export class RunManualResumeError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "RunManualResumeError";
  }
}

/** A new time window never authorizes new work or replays an approved plan. */
export function manualResumeEligibility(
  run: Run,
  routine: Routine,
): { eligible: boolean; reason: string | null } {
  let reason: string | null = null;
  if (run.routineId !== routine.id) reason = "This Run does not belong to the Routine.";
  else if (!routine.enabled) reason = "Enable the Routine before resuming its unfinished work.";
  else if (
    routine.requiresApproval ||
    routine.selfReviewOnly ||
    run.triggerKind === "approval" ||
    run.continuationOriginTriggerKind === "approval" ||
    run.continuationStopReason === HUMAN_REVIEW_STOP ||
    run.status === "reviewed"
  )
    reason = "This work requires its own human review and cannot be resumed here.";
  else if (run.status !== "failed" || run.errorKind)
    reason = "Only failed Runs with saved unfinished work can be resumed.";
  else if (!run.finishedAt) reason = "Wait for the Run to finish before resuming it.";
  else if (run.retryAt) reason = "A follow-up is already queued or starting for this Run.";
  else if (readRunCheckpoint(run)?.state !== "continue")
    reason = "This Run has no actionable saved progress to resume.";
  return { eligible: reason === null, reason };
}

/** Re-read relationships before dispatch; terminal progress alone is insufficient. */
export async function assertManualResumeSource(run: Run, routine: Routine): Promise<void> {
  const eligibility = manualResumeEligibility(run, routine);
  if (!eligibility.eligible) throw new RunManualResumeError(eligibility.reason!);
  const repo = AppDataSource.getRepository(Run);
  let cursor = run;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cursor.id) || seen.size >= MAX_RESUME_SOURCE_DEPTH)
      throw new RunManualResumeError(
        "This Run's earlier evidence cannot support another resumption.",
      );
    seen.add(cursor.id);
    if (
      cursor.triggerKind === "approval" ||
      cursor.continuationOriginTriggerKind === "approval" ||
      cursor.continuationStopReason === HUMAN_REVIEW_STOP ||
      cursor.status === "reviewed"
    )
      throw new RunManualResumeError(
        "Approved or reviewed work cannot be replayed by resuming a Run.",
      );
    if (!cursor.parentRunId) {
      if (cursor.triggerKind === "continuation" || cursor.triggerKind === "retry")
        throw new RunManualResumeError("The Run's earlier evidence is unavailable.");
      break;
    }
    const parent = await repo.findOneBy({ id: cursor.parentRunId, routineId: routine.id });
    if (!parent) throw new RunManualResumeError("The Run's earlier evidence is unavailable.");
    cursor = parent;
  }
  if (await repo.existsBy({ parentRunId: run.id }))
    throw new RunManualResumeError(
      "This Run already has a follow-up. Open its latest Run instead.",
    );
  if (await repo.existsBy({ routineId: routine.id, status: "running" }))
    throw new RunManualResumeError("This Routine already has a Run in progress.");
  if (await repo.existsBy({ routineId: routine.id, retryAt: Not(IsNull()) }))
    throw new RunManualResumeError("This Routine already has a follow-up queued or starting.");
  if (
    await repo.existsBy({
      routineId: routine.id,
      id: Not(run.id),
      startedAt: MoreThanOrEqual(run.startedAt),
    })
  )
    throw new RunManualResumeError("A newer Run exists for this Routine. Review its work first.");
}

async function loadSource(companyId: string, sourceRunId: string) {
  const run = await AppDataSource.getRepository(Run).findOneBy({ id: sourceRunId });
  const routine = run
    ? await AppDataSource.getRepository(Routine).findOneBy({ id: run.routineId })
    : null;
  const employee = routine
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({ id: routine.employeeId, companyId })
    : null;
  if (!run || !routine || !employee) throw new RunManualResumeError("Run not found.", 404);
  return { run, routine, employee };
}

async function assertAdministrator(companyId: string, userId: string) {
  const membership = await AppDataSource.getRepository(Membership).findOneBy({ companyId, userId });
  if (!membership || !["owner", "admin"].includes(membership.role))
    throw new RunManualResumeError("An administrator must authorize resuming this Run.", 403);
}

/**
 * A durable, expiring CAS serializes resumptions of the same Routine across
 * replicas. It never changes retryAt: a crashed browser request must not turn
 * into background permission to start another Run. A later explicit
 * request can reclaim an expired lease; the child row prevents any replay.
 */
async function acquireResumeClaim(routineId: string): Promise<{ name: string; holderId: string }> {
  const repo = AppDataSource.getRepository(SchedulerLease);
  const name = `routine-resume:${routineId}`;
  const holderId = randomUUID();
  await repo
    .createQueryBuilder()
    .insert()
    .values({ name, holderId: "", expiresAt: null })
    .orIgnore()
    .execute();
  const now = new Date();
  const acquired = await repo.update(
    [
      { name, expiresAt: IsNull() },
      { name, expiresAt: LessThanOrEqual(now) },
    ],
    { holderId, expiresAt: new Date(now.getTime() + RESUME_CLAIM_MS) },
  );
  if (acquired.affected !== 1)
    throw new RunManualResumeError("Unfinished work is already being resumed for this Routine.");
  return { name, holderId };
}

async function renewResumeClaim(claim: { name: string; holderId: string }) {
  const now = new Date();
  const renewed = await AppDataSource.getRepository(SchedulerLease).update(
    { ...claim, expiresAt: MoreThan(now) },
    { expiresAt: new Date(now.getTime() + RESUME_CLAIM_MS) },
  );
  if (renewed.affected !== 1)
    throw new RunManualResumeError(
      "The resumption expired before starting. Refresh and try again.",
    );
}

export async function resumeRoutineRun(args: {
  companyId: string;
  sourceRunId: string;
  userId: string;
  /** Existing API field: confirms a new Run with a fresh time window. */
  acknowledgeNewAllowance: true;
}): Promise<Run> {
  if (args.acknowledgeNewAllowance !== true)
    throw new RunManualResumeError("Confirm the new Run before resuming unfinished work.", 400);
  await assertAdministrator(args.companyId, args.userId);
  const initial = await loadSource(args.companyId, args.sourceRunId);
  const claim = await acquireResumeClaim(initial.routine.id);
  try {
    const refresh = async () => {
      await renewResumeClaim(claim);
      await assertAdministrator(args.companyId, args.userId);
      const current = await loadSource(args.companyId, args.sourceRunId);
      if (current.routine.id !== initial.routine.id || current.employee.id !== initial.employee.id)
        throw new RunManualResumeError(
          "The Routine changed before resumption. Refresh and try again.",
        );
      await assertManualResumeSource(current.run, current.routine);
      const stopped = workBlocked(args.companyId, {
        employeeId: current.employee.id,
        routineId: current.routine.id,
      });
      if (stopped.blocked)
        throw new StanddownError("This Routine is stood down and cannot resume.");
      // Policy lookups can stall too. Fence a request whose lease expired
      // during those reads before the runner can insert its child.
      await renewResumeClaim(claim);
      Object.assign(initial.routine, current.routine);
    };
    await refresh();
    const { startRoutineRun } = await import("./runner.js");
    const { run, completion } = await startRoutineRun(initial.routine, {
      triggerKind: "continuation",
      resumeFromRunId: initial.run.id,
      parentRunId: initial.run.id,
      beforeRunPersist: refresh,
    });
    void completion.catch((error) => {
      // The durable child owns its outcome even if the request has returned.
      // eslint-disable-next-line no-console
      console.error(`[runner] resumed Run ${run.id} failed after starting:`, error);
    });
    await recordAudit({
      companyId: args.companyId,
      actorUserId: args.userId,
      action: "routine.run.resume",
      targetType: "run",
      targetId: run.id,
      targetLabel: initial.routine.name,
      metadata: { sourceRunId: initial.run.id, routineId: initial.routine.id, newAllowance: true },
    });
    return run;
  } finally {
    // A late request can only release its own claim, never a replacement's.
    await AppDataSource.getRepository(SchedulerLease)
      .update(claim, { expiresAt: new Date(0) })
      .catch((error) => {
        // Expiry is recoverable; do not hide an already-created child from its caller.
        // eslint-disable-next-line no-console
        console.error("[runner] could not release a manual resumption claim:", error);
      });
  }
}
