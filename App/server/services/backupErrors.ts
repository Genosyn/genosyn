/**
 * A backup request refused for a reason the person can act on: a restore that
 * would race a backup, a copy of an archive that is no longer here, an upload
 * that isn't a complete archive. The error handler answers anything without a
 * 4xx `status` as a bare "Internal server error", which is what these used to
 * reach Admin → Backups as; carrying the status is what lets the page show the
 * actual reason beside the control that was pressed.
 *
 * Shared by `backups.ts` and `backupDestinations.ts`, which import each other's
 * neighbours but not each other's errors.
 */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 409,
    // The error behind the reason, which the operator log keeps.
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupError";
  }
}
