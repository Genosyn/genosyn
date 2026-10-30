import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatTurnActivity1793364933160 implements MigrationInterface {
    name = 'ChatTurnActivity1793364933160'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "conversation_activity_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "conversationId" varchar NOT NULL, "messageId" varchar NOT NULL, "ordinal" integer NOT NULL, "attempt" integer NOT NULL DEFAULT (1), "kind" varchar NOT NULL, "name" varchar NOT NULL DEFAULT (''), "callId" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "detailJson" text NOT NULL DEFAULT (''), "isError" boolean NOT NULL DEFAULT (0), "occurredAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_e09a9380db738e053393936ce2" ON "conversation_activity_events" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d3e4c1731f35fc1d6307cf4b55" ON "conversation_activity_events" ("conversationId") `);
        await queryRunner.query(`CREATE INDEX "IDX_28ec905d51dcc7ffbfa62a9bf0" ON "conversation_activity_events" ("messageId", "ordinal") `);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`DROP INDEX "IDX_982a58de1229f74c36fb77b12b"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer, "contextTokens" integer, "contextWindow" integer, "externalMessageId" varchar, "effort" varchar, "activityJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort" FROM "conversation_messages"`);
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
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer, "contextTokens" integer, "contextWindow" integer, "externalMessageId" varchar, "effort" varchar)`);
        await queryRunner.query(`INSERT INTO "conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort" FROM "temporary_conversation_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_982a58de1229f74c36fb77b12b" ON "conversation_messages" ("conversationId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`DROP INDEX "IDX_28ec905d51dcc7ffbfa62a9bf0"`);
        await queryRunner.query(`DROP INDEX "IDX_d3e4c1731f35fc1d6307cf4b55"`);
        await queryRunner.query(`DROP INDEX "IDX_e09a9380db738e053393936ce2"`);
        await queryRunner.query(`DROP TABLE "conversation_activity_events"`);
    }

}
