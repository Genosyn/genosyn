import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Human-in-the-loop: routines can be marked `requiresApproval`. When their
 * cron tick fires we create a pending Approval row instead of running. A
 * human decides from the Approvals inbox.
 */
export class Approvals1776800000000 implements MigrationInterface {
  name = "Approvals1776800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "routines" ADD COLUMN "requiresApproval" boolean NOT NULL DEFAULT (0)`,
    );
    await queryRunner.query(
      `CREATE TABLE "approvals" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "routineId" varchar NOT NULL,
        "employeeId" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT ('pending'),
        "requestedAt" datetime NOT NULL DEFAULT (datetime('now')),
        "decidedAt" datetime,
        "decidedByUserId" varchar
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_approvals_companyId" ON "approvals" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_approvals_routineId" ON "approvals" ("routineId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_approvals_routineId"`);
    await queryRunner.query(`DROP INDEX "IDX_approvals_companyId"`);
    await queryRunner.query(`DROP TABLE "approvals"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "requiresApproval"`);
  }
}
