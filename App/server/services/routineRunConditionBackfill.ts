import { In, IsNull, Like } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream } from "../db/entities/Workstream.js";
import { proactiveId } from "./proactive/ids.js";
import { withSchedulerLease } from "./schedulerLeases.js";

/** Recorded once the starters installed before run conditions have theirs. */
export const RUN_CONDITION_BACKFILL_KEY = "routines.runConditionBackfill";

const FOLLOW_THROUGH = "work-followthrough";

/**
 * Give every Follow through on open work starter installed before run
 * conditions existed the condition a new install gets, once.
 *
 * Those starters ran a full Run every 30 minutes (and on Workstream changes)
 * whether or not anything was due; new installs start only when a Workstream
 * revisit has come (`routineRunConditions.ts`). Each one moves to
 * `workstream_due`, and the Workstreams it resumes that have no revisit planned
 * — all of them, since `revisitAt` is new — get one now, so the work in flight
 * is looked at once more and the employee plans its next revisit then, as the
 * Run's brief asks. Without that, existing Workstreams would never be due and
 * their follow-through would go quiet.
 *
 * Only a real starter moves: its id is the starter's own deterministic id for
 * that employee and company, and it still carries the server-owned delivery
 * ceiling. A schedule or brief a Member edited is kept; the condition is
 * separate from both. A boot service rather than a migration, because this is
 * data and migrations are generated from entity diffs. It runs once, recorded in
 * an AppSetting, so a Member who sets the starter back to Every time later is
 * never overruled. The writes skip entity listeners: they are not changes a
 * Routine Trigger should fire on.
 */
export async function backfillRunConditions(
  now: Date = new Date(),
): Promise<{ routines: number; workstreams: number }> {
  const settings = AppDataSource.getRepository(AppSetting);
  const none = { routines: 0, workstreams: 0 };
  if (await settings.existsBy({ key: RUN_CONDITION_BACKFILL_KEY })) return none;
  const moved = await withSchedulerLease("run-condition-backfill", 30 * 60_000, async (lease) => {
    if (await settings.existsBy({ key: RUN_CONDITION_BACKFILL_KEY })) return none;
    const result = await conditionFollowThroughStarters(now, lease.assertHeld);
    lease.assertHeld();
    await settings.upsert(
      {
        key: RUN_CONDITION_BACKFILL_KEY,
        value: JSON.stringify({ at: now.toISOString(), ...result }),
      },
      ["key"],
    );
    return result;
  });
  return moved ?? none;
}

async function conditionFollowThroughStarters(
  now: Date,
  assertHeld: () => void,
): Promise<{ routines: number; workstreams: number }> {
  const routineRepo = AppDataSource.getRepository(Routine);
  const candidates = await routineRepo.find({
    where: {
      slug: Like(`proactive-${FOLLOW_THROUGH}-%`),
      runCondition: "always",
      mailDeliveryMode: "draft",
    },
    select: { id: true, employeeId: true, slug: true },
  });
  if (candidates.length === 0) return { routines: 0, workstreams: 0 };
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In([...new Set(candidates.map((routine) => routine.employeeId))]) },
    select: { id: true, companyId: true },
  });
  const companyOf = new Map(employees.map((employee) => [employee.id, employee.companyId]));
  const starters = candidates.filter((routine) => {
    const companyId = companyOf.get(routine.employeeId);
    return (
      companyId !== undefined &&
      routine.id === proactiveId(companyId, routine.employeeId, FOLLOW_THROUGH, null) &&
      routine.slug === `proactive-${FOLLOW_THROUGH}-${routine.id.slice(0, 8)}`
    );
  });

  let routines = 0;
  let workstreams = 0;
  for (const starter of starters) {
    assertHeld();
    const conditioned = await routineRepo
      .createQueryBuilder()
      .update(Routine)
      .set({ runCondition: "workstream_due" })
      .where({ id: starter.id, runCondition: "always" })
      .callListeners(false)
      .execute();
    if ((conditioned.affected ?? 0) === 0) continue;
    routines += 1;
    // The Workstreams this starter resumes: unbound, or bound to it.
    for (const routineId of [IsNull(), starter.id]) {
      const planned = await AppDataSource.getRepository(Workstream)
        .createQueryBuilder()
        .update(Workstream)
        // Planning a revisit is not the employee changing its work: keep the
        // update time its listings are ordered by.
        .set({ revisitAt: now, updatedAt: () => '"updatedAt"' })
        .where({
          employeeId: starter.employeeId,
          status: "active",
          revisitAt: IsNull(),
          routineId,
        })
        .callListeners(false)
        .execute();
      workstreams += planned.affected ?? 0;
    }
  }
  return { routines, workstreams };
}
