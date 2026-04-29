import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lets a Conversation belong to an external chat surface (Telegram today;
 * Slack / Discord later) instead of only the Genosyn web UI. The Telegram
 * listener uses `(source, connectionId, externalKey)` as the dedupe key so
 * each Telegram chat threads onto exactly one conversation row.
 *
 * `source` defaults to `"web"` for every existing conversation; the new
 * partial unique index only touches rows that actually carry an
 * `externalKey`, leaving the legacy web rows untouched.
 */
export class ConversationExternalSource1779900000000 implements MigrationInterface {
  name = "ConversationExternalSource1779900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "source" varchar NOT NULL DEFAULT ('web')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "externalKey" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "connectionId" varchar`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_conversations_external" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_external"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "connectionId"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "externalKey"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "source"`);
  }
}
