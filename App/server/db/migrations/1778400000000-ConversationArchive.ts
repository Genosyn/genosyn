import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `archivedAt` to `conversations` so a human can hide a thread from
 * the chat sidebar without deleting it. Unarchive sets the column back to
 * NULL — no data is ever moved or copied.
 */
export class ConversationArchive1778400000000 implements MigrationInterface {
  name = "ConversationArchive1778400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "archivedAt" datetime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "archivedAt"`,
    );
  }
}
