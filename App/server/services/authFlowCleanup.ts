import { LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AuthFlowState } from "../db/entities/AuthFlowState.js";

const SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight: Promise<number> | null = null;

/** Remove expired encrypted handoffs even when nobody starts another sign-in. */
export async function purgeExpiredAuthFlowStates(): Promise<number> {
  const deleted = await AppDataSource.getRepository(AuthFlowState).delete({
    expiresAt: LessThanOrEqual(new Date()),
  });
  return deleted.affected ?? 0;
}

function sweep(): Promise<number> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = purgeExpiredAuthFlowStates().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

/** Run after DB initialization. Concurrent replicas can safely delete expired rows. */
export async function bootAuthFlowStateSweeper(): Promise<void> {
  if (sweepTimer) return;
  await sweep();
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweep().catch(() => {
      // Never include encrypted credentials or database error payloads.
      // eslint-disable-next-line no-console
      console.warn("[auth-flow] expired sign-in state cleanup failed; will retry");
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopAuthFlowStateSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
