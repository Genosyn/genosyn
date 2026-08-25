import { MigrationInterface, QueryRunner } from "typeorm";

export class MailInboundAnalysis1787687645873 implements MigrationInterface {
    name = 'MailInboundAnalysis1787687645873'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_inbound_analyses" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "messageId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "employeeId" varchar, "modelId" varchar, "category" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "actionsJson" text NOT NULL DEFAULT ('[]'), "errorMessage" text NOT NULL DEFAULT (''), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_282e4280bb27e3440baae62d4b" ON "mail_inbound_analyses" ("messageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_064226a7f1303b8f8e4ffb47fa" ON "mail_inbound_analyses" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7c1c48e89e0b83b24910a71d42" ON "mail_inbound_analyses" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_adbb2d33d5d7b3c5833876fa5b" ON "mail_inbound_analyses" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_d30a1e4d808dccb9b90ea431aa"`);
        await queryRunner.query(`DROP INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c"`);
        await queryRunner.query(`CREATE TABLE "temporary_mail_accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "address" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "statusMessage" varchar NOT NULL DEFAULT (''), "historyId" varchar NOT NULL DEFAULT (''), "lastSyncAt" datetime, "backfilledAt" datetime, "backfillPageToken" varchar NOT NULL DEFAULT (''), "backfilledCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "syncState" varchar NOT NULL DEFAULT ('idle'), "syncAttemptId" varchar, "syncStartedAt" datetime, "syncFinishedAt" datetime, "aiAnalysisEnabled" boolean NOT NULL DEFAULT (1), "aiAnalysisEmployeeId" varchar, "aiAnalysisModelId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_mail_accounts"("id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt", "syncState", "syncAttemptId", "syncStartedAt", "syncFinishedAt") SELECT "id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt", "syncState", "syncAttemptId", "syncStartedAt", "syncFinishedAt" FROM "mail_accounts"`);
        await queryRunner.query(`DROP TABLE "mail_accounts"`);
        await queryRunner.query(`ALTER TABLE "temporary_mail_accounts" RENAME TO "mail_accounts"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d30a1e4d808dccb9b90ea431aa" ON "mail_accounts" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c" ON "mail_accounts" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c"`);
        await queryRunner.query(`DROP INDEX "IDX_d30a1e4d808dccb9b90ea431aa"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" RENAME TO "temporary_mail_accounts"`);
        await queryRunner.query(`CREATE TABLE "mail_accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "address" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "statusMessage" varchar NOT NULL DEFAULT (''), "historyId" varchar NOT NULL DEFAULT (''), "lastSyncAt" datetime, "backfilledAt" datetime, "backfillPageToken" varchar NOT NULL DEFAULT (''), "backfilledCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "syncState" varchar NOT NULL DEFAULT ('idle'), "syncAttemptId" varchar, "syncStartedAt" datetime, "syncFinishedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "mail_accounts"("id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt", "syncState", "syncAttemptId", "syncStartedAt", "syncFinishedAt") SELECT "id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt", "syncState", "syncAttemptId", "syncStartedAt", "syncFinishedAt" FROM "temporary_mail_accounts"`);
        await queryRunner.query(`DROP TABLE "temporary_mail_accounts"`);
        await queryRunner.query(`CREATE INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c" ON "mail_accounts" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d30a1e4d808dccb9b90ea431aa" ON "mail_accounts" ("connectionId") `);
        await queryRunner.query(`DROP INDEX "IDX_adbb2d33d5d7b3c5833876fa5b"`);
        await queryRunner.query(`DROP INDEX "IDX_7c1c48e89e0b83b24910a71d42"`);
        await queryRunner.query(`DROP INDEX "IDX_064226a7f1303b8f8e4ffb47fa"`);
        await queryRunner.query(`DROP INDEX "IDX_282e4280bb27e3440baae62d4b"`);
        await queryRunner.query(`DROP TABLE "mail_inbound_analyses"`);
    }

}
