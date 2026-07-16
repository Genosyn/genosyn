import { MigrationInterface, QueryRunner } from "typeorm";

export class Mail1784205338751 implements MigrationInterface {
    name = 'Mail1784205338751'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "address" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "statusMessage" varchar NOT NULL DEFAULT (''), "historyId" varchar NOT NULL DEFAULT (''), "lastSyncAt" datetime, "backfilledAt" datetime, "backfillPageToken" varchar NOT NULL DEFAULT (''), "backfilledCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d30a1e4d808dccb9b90ea431aa" ON "mail_accounts" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c" ON "mail_accounts" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "mail_threads" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "gmailThreadId" varchar NOT NULL, "subject" varchar NOT NULL DEFAULT (''), "snippet" text NOT NULL DEFAULT (''), "participants" text NOT NULL DEFAULT (''), "labelIds" text NOT NULL DEFAULT (''), "unread" boolean NOT NULL DEFAULT (0), "messageCount" integer NOT NULL DEFAULT (0), "hasAttachments" boolean NOT NULL DEFAULT (0), "lastMessageAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9ae7998b4b76daf16f8bde7bd6" ON "mail_threads" ("accountId", "gmailThreadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_011c1b38797dfe7d4d2ed3b2bd" ON "mail_threads" ("accountId", "lastMessageAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_4c23e9531595b27698260bdc77" ON "mail_threads" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "mail_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "gmailMessageId" varchar NOT NULL, "gmailThreadId" varchar NOT NULL, "gmailDraftId" varchar NOT NULL DEFAULT (''), "fromName" varchar NOT NULL DEFAULT (''), "fromEmail" varchar NOT NULL DEFAULT (''), "toEmails" text NOT NULL DEFAULT (''), "ccEmails" text NOT NULL DEFAULT (''), "bccEmails" text NOT NULL DEFAULT (''), "subject" varchar NOT NULL DEFAULT (''), "snippet" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "bodyHtml" text NOT NULL DEFAULT (''), "labelIds" text NOT NULL DEFAULT (''), "sentAt" datetime, "messageIdHeader" varchar NOT NULL DEFAULT (''), "referencesHeader" text NOT NULL DEFAULT (''), "inReplyToHeader" varchar NOT NULL DEFAULT (''), "attachmentsJson" text NOT NULL DEFAULT ('[]'), "sizeEstimate" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9236dc41f28e0328f85094c8e4" ON "mail_messages" ("accountId", "gmailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2f56c2d83926c46deb50857d3f" ON "mail_messages" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9d1e1ed9661e19183e183f4828" ON "mail_messages" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "mail_labels" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "gmailLabelId" varchar NOT NULL, "name" varchar NOT NULL, "labelType" varchar NOT NULL DEFAULT ('user'), "color" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4394d6f05a7a4b0f06b56c8fee" ON "mail_labels" ("accountId", "gmailLabelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6c94259910b3a87ba3f9b80ce2" ON "mail_labels" ("accountId") `);
        await queryRunner.query(`CREATE TABLE "mail_rules" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "name" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "position" integer NOT NULL DEFAULT (0), "conditionsJson" text NOT NULL DEFAULT ('{}'), "actionsJson" text NOT NULL DEFAULT ('[]'), "matchCount" integer NOT NULL DEFAULT (0), "lastMatchedAt" datetime, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_87e08f877deff877e5b65b4269" ON "mail_rules" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_813a21f931a9f15604df66cf6f" ON "mail_rules" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "mail_handovers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "employeeId" varchar NOT NULL, "mode" varchar NOT NULL DEFAULT ('draft'), "instruction" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('pending'), "resultSummary" text NOT NULL DEFAULT (''), "errorMessage" text NOT NULL DEFAULT (''), "sourceKind" varchar NOT NULL DEFAULT ('manual'), "ruleId" varchar, "createdByUserId" varchar, "startedAt" datetime, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7860226fe71b176673f6d72297" ON "mail_handovers" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_8a2340e56c12d2a977f2aa55f3" ON "mail_handovers" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_19d5b1a630ff1bf844936aeef3" ON "mail_handovers" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "employee_mail_account_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "accountId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('draft'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_57814960fa995b4f6ab2011b88" ON "employee_mail_account_grants" ("employeeId", "accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3a89d065d625492f147879b587" ON "employee_mail_account_grants" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_57bee47c9dca3e589b3acbee10" ON "employee_mail_account_grants" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_57bee47c9dca3e589b3acbee10"`);
        await queryRunner.query(`DROP INDEX "IDX_3a89d065d625492f147879b587"`);
        await queryRunner.query(`DROP INDEX "IDX_57814960fa995b4f6ab2011b88"`);
        await queryRunner.query(`DROP TABLE "employee_mail_account_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_19d5b1a630ff1bf844936aeef3"`);
        await queryRunner.query(`DROP INDEX "IDX_8a2340e56c12d2a977f2aa55f3"`);
        await queryRunner.query(`DROP INDEX "IDX_7860226fe71b176673f6d72297"`);
        await queryRunner.query(`DROP TABLE "mail_handovers"`);
        await queryRunner.query(`DROP INDEX "IDX_813a21f931a9f15604df66cf6f"`);
        await queryRunner.query(`DROP INDEX "IDX_87e08f877deff877e5b65b4269"`);
        await queryRunner.query(`DROP TABLE "mail_rules"`);
        await queryRunner.query(`DROP INDEX "IDX_6c94259910b3a87ba3f9b80ce2"`);
        await queryRunner.query(`DROP INDEX "IDX_4394d6f05a7a4b0f06b56c8fee"`);
        await queryRunner.query(`DROP TABLE "mail_labels"`);
        await queryRunner.query(`DROP INDEX "IDX_9d1e1ed9661e19183e183f4828"`);
        await queryRunner.query(`DROP INDEX "IDX_2f56c2d83926c46deb50857d3f"`);
        await queryRunner.query(`DROP INDEX "IDX_9236dc41f28e0328f85094c8e4"`);
        await queryRunner.query(`DROP TABLE "mail_messages"`);
        await queryRunner.query(`DROP INDEX "IDX_4c23e9531595b27698260bdc77"`);
        await queryRunner.query(`DROP INDEX "IDX_011c1b38797dfe7d4d2ed3b2bd"`);
        await queryRunner.query(`DROP INDEX "IDX_9ae7998b4b76daf16f8bde7bd6"`);
        await queryRunner.query(`DROP TABLE "mail_threads"`);
        await queryRunner.query(`DROP INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c"`);
        await queryRunner.query(`DROP INDEX "IDX_d30a1e4d808dccb9b90ea431aa"`);
        await queryRunner.query(`DROP TABLE "mail_accounts"`);
    }

}
