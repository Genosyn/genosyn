/**
 * One time window, one use. Sites reject a one-time code they have already seen, so
 * filling the same one twice, after a typo on the page or a retry a few seconds later,
 * reads as a wrong code, and a run of wrong codes locks the account. This remembers,
 * per Vault login, the last window whose code went into a page, so the next fill waits
 * for a fresh one.
 *
 * It is process-local on purpose. It only has to be right for the few seconds a window
 * lasts, a browser session lives in one process, and it's a courtesy to the site, not a
 * security boundary: a restart that forgets it costs one retry.
 */

const lastFilledWindow = new Map<string, number>();

/** Pruned on each write. Windows last seconds, so the map stays the size of a few logins. */
function prune(now: number): void {
  for (const [itemId, expiresAt] of lastFilledWindow) {
    if (expiresAt <= now) lastFilledWindow.delete(itemId);
  }
}

/** Whether this login's code for the window ending then has already gone into a page. */
export function vaultTotpWindowWasUsed(itemId: string, expiresAt: Date): boolean {
  return lastFilledWindow.get(itemId) === expiresAt.getTime();
}

/** A code from the window ending then went into a page. */
export function noteVaultTotpFilled(itemId: string, expiresAt: Date): void {
  prune(Date.now());
  lastFilledWindow.set(itemId, expiresAt.getTime());
}

/** Test seam. */
export function resetVaultTotpFreshnessForTests(): void {
  lastFilledWindow.clear();
}
