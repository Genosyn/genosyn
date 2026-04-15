import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Persisted chat threads between humans and AI employees. Replaces the
 * browser-local transcript that shipped in M7.
 */
export class Conversations1776500000000 implements MigrationInterface {
  name = "Conversations1776500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "conversations" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "title" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_employeeId" ON "conversations" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE TABLE "conversation_messages" (
        "id" varchar PRIMARY KEY NOT NULL,
        "conversationId" varchar NOT NULL,
        "role" varchar NOT NULL,
        "content" text NOT NULL DEFAULT (''),
        "status" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_messages_conversationId" ON "conversation_messages" ("conversationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversation_messages_conversationId"`);
    await queryRunner.query(`DROP TABLE "conversation_messages"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_employeeId"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
