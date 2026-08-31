import { AppDataSource } from "../db/datasource.js";
import { VaultSource } from "../db/entities/VaultSource.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { syncVaultSource } from "./vault.js";

/**
 * Keep every company's Vault in step with the external vaults it mirrors.
 *
 * Bitwarden has no change feed and no incremental sync, so this is a poll.
 * Fifteen minutes is chosen against what actually goes wrong when a mirror is
 * stale: a credential rotated in Bitwarden is still resolved live at use time,
 * so the cost of lag is limited to *new* items not appearing and *deleted*
 * items lingering as rows that fail to resolve. Neither is worth hammering an
 * operator's Vaultwarden every minute for, and an operator who wants it now
 * has a Sync button.
 *
 * Two things this pass deliberately does not do:
 *
 *  - **It does not retry a broken source on every tick.** A source whose
 *    password was changed in Bitwarden would otherwise present a failed sign-in
 *    ninety-six times a day forever, which is how an account gets rate-limited
 *    or locked. After a failure it is left alone for an hour; the operator's
 *    own Sync now is never delayed, and the row already says what went wrong.
 *  - **It does not overlap with itself.** The lease keeps two processes apart,
 *    but a single process whose pass runs past the interval would otherwise
 *    start a second one beside it.
 */
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** A source in error is left alone until its backoff has elapsed. */
function isDue(source: Pick<VaultSource, "status" | "updatedAt">, now: number): boolean {
  if (source.status !== "error") return true;
  const lastAttempt = source.updatedAt?.getTime() ?? 0;
  return now - lastAttempt >= RETRY_AFTER_FAILURE_MS;
}

export async function syncDueVaultSources(): Promise<{
  synced: number;
  failed: number;
  skipped: number;
}> {
  const rows = await AppDataSource.getRepository(VaultSource).find({
    select: { id: true, companyId: true, status: true, updatedAt: true },
  });
  const now = Date.now();
  let synced = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isDue(row, now)) {
      skipped += 1;
      continue;
    }
    try {
      await syncVaultSource({ companyId: row.companyId, sourceId: row.id });
      synced += 1;
    } catch {
      // The failure is already recorded on the source row for the operator.
      failed += 1;
    }
  }
  return { synced, failed, skipped };
}

export function bootVaultSourceSync(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    withSchedulerLease("vault-source-sync", SYNC_INTERVAL_MS - 60_000, () => syncDueVaultSources())
      .catch(() => {
        // Best-effort housekeeping; per-source failures are already persisted.
      })
      .finally(() => {
        running = false;
      });
  }, SYNC_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopVaultSourceSync(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  running = false;
}
