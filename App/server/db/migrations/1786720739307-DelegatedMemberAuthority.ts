import { MigrationInterface, QueryRunner } from "typeorm";

export class DelegatedMemberAuthority1786720739307 implements MigrationInterface {
    name = 'DelegatedMemberAuthority1786720739307'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId" FROM "conversations"`);
        await queryRunner.query(`DROP TABLE "conversations"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversations" RENAME TO "conversations"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar, "turnRequesterUserId" varchar, "turnRequesterSessionVersion" integer)`);
        await queryRunner.query(`INSERT INTO "temporary_conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId" FROM "conversation_messages"`);
        await queryRunner.query(`DROP TABLE "conversation_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversation_messages" RENAME TO "conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`DROP INDEX "IDX_19d5b1a630ff1bf844936aeef3"`);
        await queryRunner.query(`DROP INDEX "IDX_8a2340e56c12d2a977f2aa55f3"`);
        await queryRunner.query(`DROP INDEX "IDX_7860226fe71b176673f6d72297"`);
        await queryRunner.query(`CREATE TABLE "temporary_mail_handovers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "employeeId" varchar NOT NULL, "mode" varchar NOT NULL DEFAULT ('draft'), "instruction" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('pending'), "resultSummary" text NOT NULL DEFAULT (''), "errorMessage" text NOT NULL DEFAULT (''), "sourceKind" varchar NOT NULL DEFAULT ('manual'), "ruleId" varchar, "createdByUserId" varchar, "startedAt" datetime, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "requesterUserId" varchar, "requesterSessionVersion" integer)`);
        await queryRunner.query(`INSERT INTO "temporary_mail_handovers"("id", "companyId", "accountId", "threadId", "employeeId", "mode", "instruction", "status", "resultSummary", "errorMessage", "sourceKind", "ruleId", "createdByUserId", "startedAt", "finishedAt", "createdAt") SELECT "id", "companyId", "accountId", "threadId", "employeeId", "mode", "instruction", "status", "resultSummary", "errorMessage", "sourceKind", "ruleId", "createdByUserId", "startedAt", "finishedAt", "createdAt" FROM "mail_handovers"`);
        await queryRunner.query(`DROP TABLE "mail_handovers"`);
        await queryRunner.query(`ALTER TABLE "temporary_mail_handovers" RENAME TO "mail_handovers"`);
        await queryRunner.query(`CREATE INDEX "IDX_19d5b1a630ff1bf844936aeef3" ON "mail_handovers" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8a2340e56c12d2a977f2aa55f3" ON "mail_handovers" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7860226fe71b176673f6d72297" ON "mail_handovers" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`DROP INDEX "IDX_7860226fe71b176673f6d72297"`);
        await queryRunner.query(`DROP INDEX "IDX_8a2340e56c12d2a977f2aa55f3"`);
        await queryRunner.query(`DROP INDEX "IDX_19d5b1a630ff1bf844936aeef3"`);
        await queryRunner.query(`ALTER TABLE "mail_handovers" RENAME TO "temporary_mail_handovers"`);
        await queryRunner.query(`CREATE TABLE "mail_handovers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "employeeId" varchar NOT NULL, "mode" varchar NOT NULL DEFAULT ('draft'), "instruction" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('pending'), "resultSummary" text NOT NULL DEFAULT (''), "errorMessage" text NOT NULL DEFAULT (''), "sourceKind" varchar NOT NULL DEFAULT ('manual'), "ruleId" varchar, "createdByUserId" varchar, "startedAt" datetime, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "mail_handovers"("id", "companyId", "accountId", "threadId", "employeeId", "mode", "instruction", "status", "resultSummary", "errorMessage", "sourceKind", "ruleId", "createdByUserId", "startedAt", "finishedAt", "createdAt") SELECT "id", "companyId", "accountId", "threadId", "employeeId", "mode", "instruction", "status", "resultSummary", "errorMessage", "sourceKind", "ruleId", "createdByUserId", "startedAt", "finishedAt", "createdAt" FROM "temporary_mail_handovers"`);
        await queryRunner.query(`DROP TABLE "temporary_mail_handovers"`);
        await queryRunner.query(`CREATE INDEX "IDX_7860226fe71b176673f6d72297" ON "mail_handovers" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_8a2340e56c12d2a977f2aa55f3" ON "mail_handovers" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_19d5b1a630ff1bf844936aeef3" ON "mail_handovers" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`DROP INDEX "IDX_f5045a77718bdb593f309a1e25"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" RENAME TO "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE TABLE "conversation_messages" ("id" varchar PRIMARY KEY NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "content" text NOT NULL DEFAULT (''), "status" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionsJson" text NOT NULL DEFAULT (''), "progressPercent" integer, "progressLabel" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "turnUserMessageId" varchar, "turnWorkerId" varchar, "turnLeaseExpiresAt" datetime, "turnAttempt" integer NOT NULL DEFAULT (0), "turnDeadlineAt" datetime, "modelId" varchar)`);
        await queryRunner.query(`INSERT INTO "conversation_messages"("id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId") SELECT "id", "conversationId", "role", "content", "status", "createdAt", "actionsJson", "progressPercent", "progressLabel", "updatedAt", "turnUserMessageId", "turnWorkerId", "turnLeaseExpiresAt", "turnAttempt", "turnDeadlineAt", "modelId" FROM "temporary_conversation_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_conversation_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f5045a77718bdb593f309a1e25" ON "conversation_messages" ("conversationId") `);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`ALTER TABLE "conversations" RENAME TO "temporary_conversations"`);
        await queryRunner.query(`CREATE TABLE "conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar)`);
        await queryRunner.query(`INSERT INTO "conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId" FROM "temporary_conversations"`);
        await queryRunner.query(`DROP TABLE "temporary_conversations"`);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
    }

}
