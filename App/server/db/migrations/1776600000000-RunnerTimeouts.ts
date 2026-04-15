import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Real-execution plumbing: per-routine hard timeout and per-run exitCode.
 * The runner now SIGKILLs CLIs that exceed `routines.timeoutSec` and records
 * `runs.status = 'timeout'` with `exitCode = NULL`.
 */
export class RunnerTimeouts1776600000000 implements MigrationInterface {
  name = "RunnerTimeouts1776600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "routines" ADD COLUMN "timeoutSec" integer NOT NULL DEFAULT (600)`,
    );
    await queryRunner.query(
      `ALTER TABLE "runs" ADD COLUMN "exitCode" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite pre-3.35 can't DROP COLUMN. Consumers on older SQLite would need
    // to roll forward instead of down; we target 3.35+ in docs.
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "exitCode"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "timeoutSec"`);
  }
}
