import { AppDataSource } from "../db/datasource.js";
import { Run, RunStatus } from "../db/entities/Run.js";

/**
 * The one definition of "a routine failure a human still has to deal with",
 * shared by the Home "Failed routines" panel and the System Health
 * "Failed routine runs" probe. Those two surfaces are meant to agree — a row
 * dismissed on Home should not keep the health check red — so the filter that
 * decides which failures are live lives here rather than being spelled twice.
 */

/** Run statuses that mean "the work did not get done". */
export const FAILED_RUN_STATUSES: RunStatus[] = ["failed", "timeout", "interrupted"];

export type LiveRunFailureQuery = {
  routineIds: string[];
  /** How far back to look. */
  since: Date;
  /** Rows to return alongside the count. 0 counts without fetching any. */
  take: number;
};

/**
 * Failed / timed-out / interrupted runs in the window that are still worth a
 * member's attention, newest first, with the unpaginated total.
 *
 * Three things take a failure off the list:
 *
 * - a member dismissed it, so the company has already noticed;
 * - an automatic retry is still owed (`retryAt`), so the last attempt has not
 *   been spent yet;
 * - **the routine has completed a run since**, which is the interesting one.
 *   A failure the next tick fixed by itself is history, not an alert: leaving
 *   it up teaches people that the red panel is usually stale, which is exactly
 *   how a real failure gets scrolled past. The comparison is on `status`
 *   alone, the same axis the panel filters on — an outcome verdict of
 *   `off_goal` or `unverified` is a different problem with its own surfaces,
 *   and nothing here treats a missing verdict as a clean one.
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
    .orderBy("run.startedAt", "DESC");

  if (take <= 0) return { rows: [], count: await qb.getCount() };
  const [rows, count] = await qb.take(take).getManyAndCount();
  return { rows, count };
}
