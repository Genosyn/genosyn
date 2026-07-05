import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The default routine timeout moved from 10 min (`600`) to 60 min (`3600`)
 * — long agent runs were getting SIGKILLed mid-work. The sibling
 * `RoutineTimeoutDefault60m` migration only changes the column DEFAULT, which
 * applies to *future* inserts; existing routines keep whatever value was
 * copied across the table rebuild. This backfill lifts every routine still
 * sitting on the old default (`600`) up to the new one so already-created
 * routines stop timing out at 10 minutes too. Routines a human deliberately
 * customised to any other value are left untouched.
 *
 * Hand-rolled because there's no schema diff for migration:generate to notice.
 */
export class RoutineTimeoutBackfill60m1783233727725 implements MigrationInterface {
  name = "RoutineTimeoutBackfill60m1783233727725";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "routines" SET "timeoutSec" = 3600 WHERE "timeoutSec" = 600`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally irreversible. After this runs, a `3600` row is
    // indistinguishable between "backfilled from the old default" and
    // "created fresh on the new default", so blindly resetting 3600 → 600
    // would silently downgrade routines that were always meant to be 60 min.
    // We roll forward rather than strand those rows on the wrong value.
  }
}
