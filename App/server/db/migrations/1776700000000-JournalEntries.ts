import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-employee journal: an append-only operational diary. Routine runs auto-
 * emit entries; humans can add notes. Future work may feed the latest N
 * entries into the CLI prompt so employees have memory of what they've done.
 */
export class JournalEntries1776700000000 implements MigrationInterface {
  name = "JournalEntries1776700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "journal_entries" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "title" varchar NOT NULL,
        "body" text NOT NULL DEFAULT (''),
        "runId" varchar,
        "routineId" varchar,
        "authorUserId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_journal_entries_employeeId" ON "journal_entries" ("employeeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_journal_entries_employeeId"`);
    await queryRunner.query(`DROP TABLE "journal_entries"`);
  }
}
