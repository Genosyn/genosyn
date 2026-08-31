import { MigrationInterface, QueryRunner } from "typeorm";

export class ExternalChatSurfaces1788204066218 implements MigrationInterface {
    name = 'ExternalChatSurfaces1788204066218'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "external_chat_identities" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "provider" varchar NOT NULL, "connectionId" varchar NOT NULL, "externalUserId" varchar NOT NULL, "externalUserLabel" varchar, "userId" varchar, "boundAt" datetime, "boundSessionVersion" integer, "boundVia" varchar, "linkTokenHash" varchar, "linkExpiresAt" datetime, "lastSeenAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7ebc4cb41fbdd562dbdf945c69" ON "external_chat_identities" ("connectionId", "externalUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eb664fbbdd672904b9717d04f1" ON "external_chat_identities" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9e1fb4655017f013247adb4baa" ON "external_chat_identities" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer, "contextTokens" integer, "contextWindow" integer, "externalMessageId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow" FROM "conversation_messages"`);
        await queryRunner.query(`DROP TABLE "conversation_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversation_messages" RENAME TO "conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_982a58de1229f74c36fb77b12b" ON "conversation_messages" ("conversationId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_982a58de1229f74c36fb77b12b"`);
        await queryRunner.query(`DROP INDEX "IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" RENAME TO "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer, "contextTokens" integer, "contextWindow" integer)`);
        await queryRunner.query(`INSERT INTO "conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow" FROM "temporary_conversation_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`DROP INDEX "IDX_9e1fb4655017f013247adb4baa"`);
        await queryRunner.query(`DROP INDEX "IDX_eb664fbbdd672904b9717d04f1"`);
        await queryRunner.query(`DROP INDEX "IDX_7ebc4cb41fbdd562dbdf945c69"`);
        await queryRunner.query(`DROP TABLE "external_chat_identities"`);
    }

}
