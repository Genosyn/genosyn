import { MigrationInterface, QueryRunner } from "typeorm";

export class AuditEvents1777200000000 implements MigrationInterface {
  name = "AuditEvents1777200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_events" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "actorKind" varchar NOT NULL DEFAULT ('user'),
        "actorUserId" varchar,
        "action" varchar NOT NULL,
        "targetType" varchar NOT NULL DEFAULT (''),
        "targetId" varchar,
        "targetLabel" varchar NOT NULL DEFAULT (''),
        "metadataJson" text NOT NULL DEFAULT (''),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_company_createdAt" ON "audit_events" ("companyId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_audit_company_createdAt"`);
    await queryRunner.query(`DROP TABLE "audit_events"`);
  }
}
