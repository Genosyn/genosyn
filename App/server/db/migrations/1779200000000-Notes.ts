import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Notes — Notion-style company-wide markdown knowledge base, readable and
 * writable by both human Members and AI Employees. Distinct from the
 * per-employee Journal (diary feed) and per-employee Memory (durable
 * facts injected into prompts). Hierarchy is modeled via the optional
 * `parentId` self-reference; `archivedAt` is a soft-delete timestamp.
 */
export class Notes1779200000000 implements MigrationInterface {
  name = "Notes1779200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notes" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "title" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "body" text NOT NULL DEFAULT (''),
        "icon" varchar NOT NULL DEFAULT (''),
        "parentId" varchar,
        "sortOrder" integer NOT NULL DEFAULT (0),
        "createdById" varchar,
        "createdByEmployeeId" varchar,
        "lastEditedById" varchar,
        "lastEditedByEmployeeId" varchar,
        "archivedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_notes_companyId_slug" ON "notes" ("companyId", "slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notes_companyId_parentId" ON "notes" ("companyId", "parentId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_companyId_parentId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "notes"`);
  }
}
