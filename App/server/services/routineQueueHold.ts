import { setTimeout as sleep } from "node:timers/promises";
import { AppDataSource } from "../db/datasource.js";
import { Run } from "../db/entities/Run.js";
import { SchedulerLease } from "../db/entities/SchedulerLease.js";

/**
 * Hold the Routine queue while Genosyn is about to restart for an upgrade.
 *
 * A restart ends every running Run, and a self-hosted model's Runs are long:
 * the nightly automatic upgrade at 02:17 restarted one install on five of
 * eleven nights, each time cutting off the Routine working then. Before
 * `genosyn upgrade` stops the container it holds the queue and waits for the
 * running Runs to finish. Queued and newly scheduled Runs wait in the database
 * and start in the upgraded container, which releases the hold as it boots.
 * The hold also expires on its own, so an upgrade that never restarts cannot
 * hold the queue for good.
 */
const HOLD_LEASE = "routine-queue-hold";

/** How long the hold outlasts the wait, to cover stopping and replacing the container. */
export const HOLD_MARGIN_MS = 10 * 60_000;

export async function holdRoutineQueue(until: Date): Promise<void> {
  const repo = AppDataSource.getRepository(SchedulerLease);
  await repo
    .createQueryBuilder()
    .insert()
    .values({ name: HOLD_LEASE, holderId: "upgrade", expiresAt: until })
    .orIgnore()
    .execute();
  await repo.update({ name: HOLD_LEASE }, { holderId: "upgrade", expiresAt: until });
}

export async function releaseRoutineQueue(): Promise<void> {
  await AppDataSource.getRepository(SchedulerLease).delete({ name: HOLD_LEASE });
}

/** When the hold ends, or null when the queue is not held. */
export async function routineQueueHeldUntil(now: Date = new Date()): Promise<Date | null> {
  const lease = await AppDataSource.getRepository(SchedulerLease).findOneBy({ name: HOLD_LEASE });
  const until = lease?.expiresAt ?? null;
  return until && until.getTime() > now.getTime() ? until : null;
}

/**
 * Hold the queue and wait until no Routine Run is running, or until `minutes`
 * have passed. Returns how many Runs are still running: 0 once drained.
 */
export async function drainRoutineRuns(args: {
  minutes: number;
  pollMs?: number;
  onWaiting?: (running: number, waitedMs: number) => void;
}): Promise<number> {
  const started = Date.now();
  const deadline = started + Math.max(0, args.minutes) * 60_000;
  await holdRoutineQueue(new Date(deadline + HOLD_MARGIN_MS));
  const runs = AppDataSource.getRepository(Run);
  for (;;) {
    const running = await runs.countBy({ status: "running" });
    const now = Date.now();
    if (running === 0 || now >= deadline) return running;
    args.onWaiting?.(running, now - started);
    await sleep(Math.min(args.pollMs ?? 10_000, deadline - now));
  }
}
