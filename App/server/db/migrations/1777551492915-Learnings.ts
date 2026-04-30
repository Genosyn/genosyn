import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * M18 — "Learnings" feature (later renamed to "Resources" by
 * 1777554798118-RenameLearningsToResources). Adds two tables and drops the
 * unused `runs.logsPath` column that older runs predated `logContent`.
 *
 * **Why this migration was rewritten in place.** The version originally
 * emitted by `migration:generate` against a developer DB also tried to
 * rename ~80 stable index names to TypeORM's hash-based names — some of
 * which (e.g. `IDX_conversations_external`) belong to migrations with
 * *later* timestamps that hadn't run yet on a fresh server. On any DB
 * coming from upstream the migration aborted with `no such index:
 * IDX_conversations_external` and rolled back. The rewrite drops the
 * spurious renames and keeps only the work the M18 commit actually
 * intended. The follow-up `RenameLearningsToResources` migration drops
 * the two tables created here by the same hash-named indexes, so those
 * names must not change.
 */
export class Learnings1777551492915 implements MigrationInterface {
  name = "Learnings1777551492915";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Learnings tables. `IF NOT EXISTS` is defensive: a previous failed
    // run inside the same transaction would have rolled back, but a user
    // who manually patched their DB shouldn't get a second error here.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "learnings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "sourceKind" varchar NOT NULL DEFAULT ('url'), "sourceUrl" varchar, "sourceFilename" varchar, "storageKey" varchar, "summary" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "tags" varchar NOT NULL DEFAULT (''), "bytes" bigint NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('pending'), "errorMessage" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_0e31b3a842bb3bfc9eb2b00f14" ON "learnings" ("companyId", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_5968fa55352eb5a71f45f02323" ON "learnings" ("companyId", "slug") `,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "employee_learning_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "learningId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_aa67e2f19cf2719d133a9057bd" ON "employee_learning_grants" ("employeeId", "learningId") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_69b8b1f5be86152a92698eda85" ON "employee_learning_grants" ("learningId") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_76666070ddf36fd1f3ee6316b0" ON "employee_learning_grants" ("employeeId") `,
    );

    // Drop the now-unused `logsPath` column from `runs`. SQLite < 3.35
    // can't `ALTER TABLE … DROP COLUMN`, so do the standard rename-table
    // rebuild. `logContent` (added by 1777500000000-MarkdownToDb) and
    // `exitCode` (added by 1776600000000-RunnerTimeouts) are preserved.
    await queryRunner.query(
      `CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''))`,
    );
    await queryRunner.query(
      `INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent" FROM "runs"`,
    );
    await queryRunner.query(`DROP TABLE "runs"`);
    await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the `logsPath` column on `runs`.
    await queryRunner.query(
      `CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "logsPath" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''))`,
    );
    await queryRunner.query(
      `INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent" FROM "runs"`,
    );
    await queryRunner.query(`DROP TABLE "runs"`);
    await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);

    // Drop the M18 Learnings tables.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_76666070ddf36fd1f3ee6316b0"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_69b8b1f5be86152a92698eda85"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_aa67e2f19cf2719d133a9057bd"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "employee_learning_grants"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_5968fa55352eb5a71f45f02323"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_0e31b3a842bb3bfc9eb2b00f14"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "learnings"`);
  }
}
