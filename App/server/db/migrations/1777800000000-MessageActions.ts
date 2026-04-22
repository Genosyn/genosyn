import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Give `conversation_messages` a place to persist the list of tool-driven
 * writes (routine.create, todo.create, ...) performed by an AI employee
 * during the chat turn that produced the message. Renders as action pills
 * below the assistant bubble so humans can see what actually happened in
 * Genosyn — not just what the model said it did.
 */
export class MessageActions1777800000000 implements MigrationInterface {
  name = "MessageActions1777800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD COLUMN "actionsJson" text NOT NULL DEFAULT ('')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "actionsJson"`,
    );
  }
}
