import { MigrationInterface, QueryRunner } from "typeorm";

export class DurableChatTurns1785244637399 implements MigrationInterface {
    name = 'DurableChatTurns1785244637399'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "temporary_conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson" FROM "conversation_messages"`);
        await queryRunner.query(`DROP TABLE "conversation_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversation_messages" RENAME TO "conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" RENAME TO "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson" FROM "temporary_conversation_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
    }

}
