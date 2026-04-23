import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add `nextRunAt` to routines so the heartbeat scheduler can pick up due rows.
 *
 * Left null for existing rows — the boot-time sweep in `services/cron.ts`
 * computes a value on first startup after this migration. Starting null (vs
 * backfilling with "now") keeps the migration pure-schema and avoids binding
 * the rollout to an exact clock moment.
 */
export class RoutineNextRunAt1778500000000 implements MigrationInterface {
  name = "RoutineNextRunAt1778500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "routines" ADD COLUMN "nextRunAt" datetime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "nextRunAt"`);
  }
}
