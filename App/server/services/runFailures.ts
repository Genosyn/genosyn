import { AppDataSource } from "../db/datasource.js";
import { Run, RunStatus } from "../db/entities/Run.js";

/**
 * The one definition of "a routine failure a human still has to deal with",
 * shared by the Home and System Health "Routines needing attention" surfaces.
 * Those two surfaces are meant to agree — a row
 * dismissed on Home should not keep the health check red — so the filter that
 * decides which failures are live lives here rather than being spelled twice.
 */

/** Run statuses that mean "the work did not get done". */
export const FAILED_RUN_STATUSES: RunStatus[] = ["failed", "error", "timeout", "interrupted"];

export type LiveRunFailureQuery = {
  routineIds: string[];
  /** How far back to look. */
  since: Date;
  /** Rows to return alongside the count. 0 counts without fetching any. */
  take: number;
};

/**
 * Failed Runs and Errors in the window that are still worth a
 * member's attention, newest first, with the unpaginated total.
 *
 * Four things take a failure off the list:
 *
 * - a member dismissed it, so the company has already noticed;
 * - an automatic retry is still owed (`retryAt`), so the last attempt has not
 *   been spent yet;
 * - a continuation has taken over the unfinished work. Its eventual failure
 *   is the one a Member should see; a skipped child leaves its parent visible.
 *   A continuation retaining its server-owned review scope can finish reviewed:
 *   that review owns the next step, without claiming verified delivery;
 * - **the routine has completed a run since**, which is the interesting one.
 *   A failure the next tick fixed by itself is history, not an alert: leaving
 *   it up teaches people that the red panel is usually stale, which is exactly
 *   how a real failure gets scrolled past. Off-goal grading now changes the
 *   later Run to Failed, so it cannot clear a prior failure. Unverified work
 *   still carries its separate assessment; clearing an older alert does not
 *   establish that the later work was verified.
 */
export async function findLiveRunFailures({
  routineIds,
  since,
  take,
}: LiveRunFailureQuery): Promise<{ rows: Run[]; count: number }> {
  if (routineIds.length === 0) return { rows: [], count: 0 };

  const qb = AppDataSource.getRepository(Run)
    .createQueryBuilder("run")
    .where("run.routineId IN (:...routineIds)", { routineIds })
    .andWhere("run.status IN (:...failedStatuses)", { failedStatuses: FAILED_RUN_STATUSES })
    .andWhere("run.startedAt >= :since", { since })
    .andWhere("run.dismissedAt IS NULL")
    .andWhere("run.retryAt IS NULL")
    .andWhere((sub) => {
      const continuation = sub
        .subQuery()
        .select("1")
        .from(Run, "continuation")
        .where("continuation.parentRunId = run.id")
        .andWhere("continuation.routineId = run.routineId")
        .andWhere("continuation.triggerKind = :continuationTrigger")
        .andWhere(
          "(continuation.status IN (:...continuationStatuses) OR " +
            "(continuation.status = :reviewedContinuationStatus AND " +
            "continuation.continuationReviewOnly = :reviewedContinuationScope))",
        )
        .getQuery();
      return `NOT EXISTS ${continuation}`;
    })
    .andWhere((sub) => {
      const later = sub
        .subQuery()
        .select("1")
        .from(Run, "later")
        .where("later.routineId = run.routineId")
        .andWhere("later.status = :completedStatus")
        .andWhere("later.startedAt > run.startedAt")
        .getQuery();
      return `NOT EXISTS ${later}`;
    })
    .setParameter("completedStatus", "completed" satisfies RunStatus)
    .setParameter("continuationTrigger", "continuation")
    .setParameter("continuationStatuses", [
      "queued",
      "running",
      "completed",
      ...FAILED_RUN_STATUSES,
    ])
    .setParameter("reviewedContinuationStatus", "reviewed" satisfies RunStatus)
    .setParameter("reviewedContinuationScope", true)
    .orderBy("run.startedAt", "DESC");

  if (take <= 0) return { rows: [], count: await qb.getCount() };
  const [rows, count] = await qb.take(take).getManyAndCount();
  return { rows, count };
}
