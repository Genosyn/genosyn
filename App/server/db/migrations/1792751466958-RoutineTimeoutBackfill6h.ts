import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The default routine timeout moved from 60 min (`3600`) to 6 h (`21600`):
 * an initial Run and its automatic continuations share one time window, and
 * Routines on slow local models kept ending as timeout Errors with their work
 * unfinished. The sibling `RoutineTimeoutDefault6h` migration only changes the
 * column DEFAULT, which applies to future inserts. This backfill lifts every
 * existing routine below 6 h to it — not only those on the old default, since
 * the ones timing out were mostly set to an hour or two by hand. 6 h is also
 * the editor's ceiling, so nothing already at it changes.
 *
 * Hand-rolled because there's no schema diff for migration:generate to notice.
 */
export class RoutineTimeoutBackfill6h1792751466958 implements MigrationInterface {
  name = "RoutineTimeoutBackfill6h1792751466958";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "routines" SET "timeoutSec" = 21600 WHERE "timeoutSec" < 21600`);
  }

  public async down(): Promise<void> {
    // Intentionally irreversible. The previous per-routine values are gone,
    // and resetting every 6 h routine to one guess would silently shorten
    // routines that were always meant to have 6 h.
  }
}
