import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A comment thread on a Todo. Humans and AI employees post into the same
 * stream — `authorUserId` xor `authorEmployeeId` identifies the voice.
 */
export class TodoComments1776400000000 implements MigrationInterface {
  name = "TodoComments1776400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "todo_comments" (
        "id" varchar PRIMARY KEY NOT NULL,
        "todoId" varchar NOT NULL,
        "authorUserId" varchar,
        "authorEmployeeId" varchar,
        "body" text NOT NULL DEFAULT (''),
        "pending" boolean NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_todo_comments_todoId" ON "todo_comments" ("todoId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_todo_comments_todoId"`);
    await queryRunner.query(`DROP TABLE "todo_comments"`);
  }
}
