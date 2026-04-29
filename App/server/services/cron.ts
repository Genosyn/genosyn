import parser from "cron-parser";
import { IsNull, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { runRoutine } from "./runner.js";
import { notifyApprovalPending } from "./notifications.js";

/**
 * Heartbeat-based routine scheduler.
 *
 * Instead of holding one in-memory `node-cron` timer per routine, we persist
 * the next due time on each `Routine` row (`nextRunAt`) and poll every
 * {@link HEARTBEAT_INTERVAL_MS}. Due rows get advanced + fired.
 *
 * Catch-up after downtime is **fire-at-most-once**: if the server was down
 * across many scheduled ticks, the routine fires once on the next heartbeat
 * (not N times). This is implemented by advancing `nextRunAt` from *now*
 * rather than from the stale `nextRunAt`, so we skip past all missed slots.
 */

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Compute the next scheduled fire time for a cron expression, or null if the
 * expression is invalid. `from` defaults to now; callers pass a specific
 * moment when they want "next after this run" semantics.
 */
export function nextRunFor(cronExpr: string, from: Date = new Date()): Date | null {
  try {
    const interval = parser.parseExpression(cronExpr, { currentDate: from });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Mutate a routine's `nextRunAt` based on its current cron/enabled state.
 * Callers save the row afterward. When disabled or when the expression is
 * unparseable we clear `nextRunAt` so the heartbeat ignores the row.
 */
export function registerRoutine(routine: Routine): void {
  if (!routine.enabled) {
    routine.nextRunAt = null;
    return;
  }
  routine.nextRunAt = nextRunFor(routine.cronExpr);
}

async function tickRoutine(routineId: string): Promise<void> {
  // Re-fetch each tick so edits (including flipping requiresApproval or
  // disabling the routine) take effect without restarting the process.
  const repo = AppDataSource.getRepository(Routine);
  const fresh = await repo.findOneBy({ id: routineId });
  if (!fresh || !fresh.enabled) return;
  if (fresh.requiresApproval) {
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: fresh.employeeId,
    });
    if (!emp) return;
    const approvalRepo = AppDataSource.getRepository(Approval);
    const pending = approvalRepo.create({
      companyId: emp.companyId,
      routineId: fresh.id,
      employeeId: emp.id,
      status: "pending",
    });
    await approvalRepo.save(pending);
    void notifyApprovalPending(pending).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[cron] notify approval pending failed:", e);
    });
    await AppDataSource.getRepository(JournalEntry).save(
      AppDataSource.getRepository(JournalEntry).create({
        employeeId: emp.id,
        kind: "system",
        title: `Approval requested for routine "${fresh.name}"`,
        body: "Cron tick was gated; waiting for a human to approve or reject.",
        routineId: fresh.id,
        runId: null,
        authorUserId: null,
      }),
    );
    return;
  }
  await runRoutine(fresh);
}

/**
 * One heartbeat pass. Finds enabled routines whose `nextRunAt` has come due,
 * advances their schedule past now (fire-at-most-once), saves, and fires the
 * run in the background.
 *
 * The outer guard (`ticking`) prevents overlapping passes if a heartbeat
 * interval fires while the previous pass is still writing rows — cheap
 * insurance, since a single SQLite connection serializes writes anyway.
 */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const repo = AppDataSource.getRepository(Routine);
    const now = new Date();
    const due = await repo.find({
      where: { enabled: true, nextRunAt: LessThanOrEqual(now) },
    });
    for (const r of due) {
      // Advance BEFORE firing so a long-running routine doesn't re-trigger
      // on the next heartbeat. Compute from `now` (not r.nextRunAt) so we
      // collapse missed slots into a single catch-up run.
      r.nextRunAt = nextRunFor(r.cronExpr, now);
      await repo.save(r);
      tickRoutine(r.id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[cron] routine ${r.id} failed:`, err);
      });
    }
  } finally {
    ticking = false;
  }
}

/**
 * Fill in `nextRunAt` for any enabled routine that doesn't have one. Runs on
 * boot to handle (a) rows created before this column existed, and (b) rows
 * where a prior boot failed to compute a schedule (e.g. transient parse
 * error). Sets the next time relative to *now* so we don't try to fabricate
 * a missed history.
 */
async function initialSweep(): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  const orphans = await repo.find({
    where: { enabled: true, nextRunAt: IsNull() },
  });
  if (orphans.length === 0) return;
  const now = new Date();
  for (const r of orphans) {
    r.nextRunAt = nextRunFor(r.cronExpr, now);
    await repo.save(r);
  }
}

export async function bootCron(): Promise<void> {
  await initialSweep();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[cron] heartbeat failed:", err);
    });
  }, HEARTBEAT_INTERVAL_MS);
  // Kick an immediate pass so a just-rebooted server catches up without
  // waiting a full heartbeat interval first.
  tick().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[cron] initial tick failed:", err);
  });
}
