import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatThinkingLevels1793381510585 implements MigrationInterface {
    name = 'ChatThinkingLevels1793381510585'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_models" ("id" varchar PRIMARY KEY NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar NOT NULL, "defaultEffort" varchar, "effortCeiling" varchar, "customThinkingLevels" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_ai_models"("id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "ai_models"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_models" RENAME TO "ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_11107f72f0e23051f012c69f3e"`);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar, "memberBrowserId" varchar, "discussedDecisionId" varchar, "effort" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId", "discussedDecisionId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId", "discussedDecisionId" FROM "conversations"`);
        await queryRunner.query(`DROP TABLE "conversations"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversations" RENAME TO "conversations"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_11107f72f0e23051f012c69f3e" ON "conversations" ("discussedDecisionId", "ownerUserId") WHERE "discussedDecisionId" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
        await queryRunner.query(`DROP INDEX "IDX_982a58de1229f74c36fb77b12b"`);
        await queryRunner.query(`DROP INDEX "IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer, "contextTokens" integer, "contextWindow" integer, "externalMessageId" varchar, "effort" varchar, "activityJson" text NOT NULL DEFAULT (''), "thinkingJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort", "activityJson") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort", "activityJson" FROM "conversation_messages"`);
        await queryRunner.query(`DROP TABLE "conversation_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversation_messages" RENAME TO "conversation_messages"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_982a58de1229f74c36fb77b12b" ON "conversation_messages" ("conversationId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`DROP INDEX "IDX_982a58de1229f74c36fb77b12b"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" RENAME TO "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer, "contextTokens" integer, "contextWindow" integer, "externalMessageId" varchar, "effort" varchar, "activityJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort", "activityJson") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId", "turnRequesterUserId", "turnRequesterSessionVersion", "contextTokens", "contextWindow", "externalMessageId", "effort", "activityJson" FROM "temporary_conversation_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_982a58de1229f74c36fb77b12b" ON "conversation_messages" ("conversationId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`DROP INDEX "IDX_11107f72f0e23051f012c69f3e"`);
        await queryRunner.query(`ALTER TABLE "conversations" RENAME TO "temporary_conversations"`);
        await queryRunner.query(`CREATE TABLE "conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar, "memberBrowserId" varchar, "discussedDecisionId" varchar)`);
        await queryRunner.query(`INSERT INTO "conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId", "discussedDecisionId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId", "memberBrowserId", "discussedDecisionId" FROM "temporary_conversations"`);
        await queryRunner.query(`DROP TABLE "temporary_conversations"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_11107f72f0e23051f012c69f3e" ON "conversations" ("discussedDecisionId", "ownerUserId") WHERE "discussedDecisionId" IS NOT NULL`);
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`ALTER TABLE "ai_models" RENAME TO "temporary_ai_models"`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar NOT NULL)`);
        await queryRunner.query(`INSERT INTO "ai_models"("id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "temporary_ai_models"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
    }

}
