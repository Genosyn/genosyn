import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Generalize the routine-only Approval surface so it can also gate non-
 * routine actions — first use case is Lightning payments above a per-
 * Connection threshold (M13). Adds `kind`, optional `title`, `summary`,
 * `payloadJson`, `resultJson`, `errorMessage`. Existing rows backfill to
 * `kind = 'routine'` with the empty string in the new optional fields.
 */
export class ApprovalKinds1780100000000 implements MigrationInterface {
  name = "ApprovalKinds1780100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "approvals" ADD COLUMN "kind" varchar NOT NULL DEFAULT ('routine')`,
    );
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "title" varchar`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "summary" text`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "payloadJson" text`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "resultJson" text`);
    await queryRunner.query(`ALTER TABLE "approvals" ADD COLUMN "errorMessage" text`);
    await queryRunner.query(
      `CREATE INDEX "IDX_approvals_kind" ON "approvals" ("kind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_approvals_kind"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "errorMessage"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "resultJson"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "payloadJson"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "summary"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "title"`);
    await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "kind"`);
  }
}
