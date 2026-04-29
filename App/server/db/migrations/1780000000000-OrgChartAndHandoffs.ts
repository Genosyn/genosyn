import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase B of the AI↔AI fabric: Teams (org structure) and Handoffs (formal
 * delegation between AI Employees).
 *
 * - `teams` groups employees inside a Company. One-to-many for V1; an
 *   AIEmployee can belong to at most one team via `ai_employees.teamId`.
 * - `ai_employees.reportsToEmployeeId` is a self-FK that powers the
 *   `create_handoff` `manager: true` shortcut and future escalation rules.
 * - `handoffs` carries one piece of delegated work between two employees.
 *   Status is a free-form varchar (pending | completed | declined |
 *   cancelled) so we don't need a CHECK constraint or rebuild the table
 *   every time we extend the workflow.
 */
export class OrgChartAndHandoffs1780000000000 implements MigrationInterface {
  name = "OrgChartAndHandoffs1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "teams" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "description" text NOT NULL DEFAULT (''),
        "archivedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_teams_companyId_slug" ON "teams" ("companyId", "slug")`,
    );

    await queryRunner.query(
      `ALTER TABLE "ai_employees" ADD COLUMN "teamId" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai_employees" ADD COLUMN "reportsToEmployeeId" varchar`,
    );

    await queryRunner.query(
      `CREATE TABLE "handoffs" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "fromEmployeeId" varchar NOT NULL,
        "toEmployeeId" varchar NOT NULL,
        "title" varchar NOT NULL,
        "body" text NOT NULL DEFAULT (''),
        "status" varchar NOT NULL DEFAULT ('pending'),
        "resolutionNote" text,
        "dueAt" datetime,
        "completedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handoffs_companyId_status" ON "handoffs" ("companyId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handoffs_toEmployeeId_status" ON "handoffs" ("toEmployeeId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_handoffs_fromEmployeeId" ON "handoffs" ("fromEmployeeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_handoffs_fromEmployeeId"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_handoffs_toEmployeeId_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_handoffs_companyId_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "handoffs"`);

    await queryRunner.query(
      `ALTER TABLE "ai_employees" DROP COLUMN "reportsToEmployeeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ai_employees" DROP COLUMN "teamId"`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_teams_companyId_slug"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "teams"`);
  }
}
