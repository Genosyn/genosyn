import { MigrationInterface, QueryRunner } from "typeorm";
import { randomUUID } from "node:crypto";

/**
 * Notebooks — top-level grouping for Notes. Every Note now lives in
 * exactly one Notebook; notebooks themselves do not nest. The Note tree
 * (`Note.parentId`) keeps working *within* a notebook, so existing nested
 * pages stay nested.
 *
 * Each existing company gets a seeded "General" notebook, and every
 * existing note is reassigned to it. The notes table is rebuilt to make
 * `notebookId` NOT NULL — SQLite can't add a NOT NULL column without a
 * default and we don't want a sentinel default lying around.
 */
export class Notebooks1779700000000 implements MigrationInterface {
  name = "Notebooks1779700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notebooks" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "title" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "icon" varchar NOT NULL DEFAULT (''),
        "sortOrder" integer NOT NULL DEFAULT (0),
        "createdById" varchar,
        "createdByEmployeeId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_notebooks_companyId_slug" ON "notebooks" ("companyId", "slug")`,
    );

    // Seed one "General" notebook per existing company so every note has a
    // home. Companies created after this migration get their default
    // notebook from the company-create route instead.
    const companies: Array<{ id: string }> = await queryRunner.query(
      `SELECT id FROM "companies"`,
    );
    const notebookByCompany = new Map<string, string>();
    for (const c of companies) {
      const id = randomUUID();
      notebookByCompany.set(c.id, id);
      await queryRunner.query(
        `INSERT INTO "notebooks" ("id", "companyId", "title", "slug", "icon", "sortOrder")
         VALUES (?, ?, 'General', 'general', '📚', 0)`,
        [id, c.id],
      );
    }

    // Rebuild "notes" with a NOT NULL "notebookId". SQLite-compatible
    // (CREATE _new → INSERT … SELECT → DROP old → RENAME). The lookup map
    // above gives us the per-row notebookId without an N×M correlated
    // subquery.
    await queryRunner.query(
      `CREATE TABLE "notes_new" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "notebookId" varchar NOT NULL,
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

    if (notebookByCompany.size > 0) {
      // One INSERT per company so we can stamp the right notebookId.
      for (const [companyId, notebookId] of notebookByCompany) {
        await queryRunner.query(
          `INSERT INTO "notes_new" (
            "id", "companyId", "notebookId", "title", "slug", "body", "icon",
            "parentId", "sortOrder", "createdById", "createdByEmployeeId",
            "lastEditedById", "lastEditedByEmployeeId", "archivedAt",
            "createdAt", "updatedAt"
          )
          SELECT
            "id", "companyId", ?, "title", "slug", "body", "icon",
            "parentId", "sortOrder", "createdById", "createdByEmployeeId",
            "lastEditedById", "lastEditedByEmployeeId", "archivedAt",
            "createdAt", "updatedAt"
          FROM "notes" WHERE "companyId" = ?`,
          [notebookId, companyId],
        );
      }
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_companyId_parentId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "notes"`);
    await queryRunner.query(`ALTER TABLE "notes_new" RENAME TO "notes"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_notes_companyId_slug" ON "notes" ("companyId", "slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notes_companyId_notebookId" ON "notes" ("companyId", "notebookId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notes_notebookId_parentId" ON "notes" ("notebookId", "parentId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notes_old" (
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
      `INSERT INTO "notes_old" (
        "id", "companyId", "title", "slug", "body", "icon",
        "parentId", "sortOrder", "createdById", "createdByEmployeeId",
        "lastEditedById", "lastEditedByEmployeeId", "archivedAt",
        "createdAt", "updatedAt"
      )
      SELECT
        "id", "companyId", "title", "slug", "body", "icon",
        "parentId", "sortOrder", "createdById", "createdByEmployeeId",
        "lastEditedById", "lastEditedByEmployeeId", "archivedAt",
        "createdAt", "updatedAt"
      FROM "notes"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_notebookId_parentId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_companyId_notebookId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notes_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "notes"`);
    await queryRunner.query(`ALTER TABLE "notes_old" RENAME TO "notes"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_notes_companyId_slug" ON "notes" ("companyId", "slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notes_companyId_parentId" ON "notes" ("companyId", "parentId")`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notebooks_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "notebooks"`);
  }
}
