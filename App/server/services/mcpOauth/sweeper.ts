import { pruneUnusedClients } from "./clients.js";
import { sweepExpiredConnectedAppTokens } from "./tokens.js";

/**
 * Housekeeping for OAuth: tokens past their expiry, and client registrations
 * nobody ever connected. Neither is needed for correctness — an expired token
 * is refused whether or not its row is still there — so a failed sweep only
 * waits for the next one.
 */

const SWEEP_INTERVAL_MS = 60 * 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

async function sweep(): Promise<void> {
  try {
    await sweepExpiredConnectedAppTokens();
    await pruneUnusedClients();
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[mcp-oauth] token and client cleanup failed; will retry");
  }
}

/** Run after DB initialization. Concurrent replicas can safely sweep the same rows. */
export async function bootConnectedAppSweeper(): Promise<void> {
  if (sweepTimer) return;
  await sweep();
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopConnectedAppSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
