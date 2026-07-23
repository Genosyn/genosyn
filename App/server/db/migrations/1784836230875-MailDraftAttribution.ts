import { MigrationInterface, QueryRunner } from "typeorm";

export class MailDraftAttribution1784836230875 implements MigrationInterface {
    name = 'MailDraftAttribution1784836230875'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9d1e1ed9661e19183e183f4828"`);
        await queryRunner.query(`DROP INDEX "IDX_2f56c2d83926c46deb50857d3f"`);
        await queryRunner.query(`DROP INDEX "IDX_9236dc41f28e0328f85094c8e4"`);
        await queryRunner.query(`CREATE TABLE "temporary_mail_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "gmailMessageId" varchar NOT NULL, "gmailThreadId" varchar NOT NULL, "gmailDraftId" varchar NOT NULL DEFAULT (''), "fromName" varchar NOT NULL DEFAULT (''), "fromEmail" varchar NOT NULL DEFAULT (''), "toEmails" text NOT NULL DEFAULT (''), "ccEmails" text NOT NULL DEFAULT (''), "bccEmails" text NOT NULL DEFAULT (''), "subject" varchar NOT NULL DEFAULT (''), "snippet" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "bodyHtml" text NOT NULL DEFAULT (''), "labelIds" text NOT NULL DEFAULT (''), "sentAt" datetime, "messageIdHeader" varchar NOT NULL DEFAULT (''), "referencesHeader" text NOT NULL DEFAULT (''), "inReplyToHeader" varchar NOT NULL DEFAULT (''), "attachmentsJson" text NOT NULL DEFAULT ('[]'), "sizeEstimate" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdByRoutineId" varchar, "createdByRunId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_mail_messages"("id", "companyId", "accountId", "threadId", "gmailMessageId", "gmailThreadId", "gmailDraftId", "fromName", "fromEmail", "toEmails", "ccEmails", "bccEmails", "subject", "snippet", "bodyText", "bodyHtml", "labelIds", "sentAt", "messageIdHeader", "referencesHeader", "inReplyToHeader", "attachmentsJson", "sizeEstimate", "createdAt", "updatedAt") SELECT "id", "companyId", "accountId", "threadId", "gmailMessageId", "gmailThreadId", "gmailDraftId", "fromName", "fromEmail", "toEmails", "ccEmails", "bccEmails", "subject", "snippet", "bodyText", "bodyHtml", "labelIds", "sentAt", "messageIdHeader", "referencesHeader", "inReplyToHeader", "attachmentsJson", "sizeEstimate", "createdAt", "updatedAt" FROM "mail_messages"`);
        await queryRunner.query(`DROP TABLE "mail_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_mail_messages" RENAME TO "mail_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_9d1e1ed9661e19183e183f4828" ON "mail_messages" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2f56c2d83926c46deb50857d3f" ON "mail_messages" ("threadId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9236dc41f28e0328f85094c8e4" ON "mail_messages" ("accountId", "gmailMessageId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9236dc41f28e0328f85094c8e4"`);
        await queryRunner.query(`DROP INDEX "IDX_2f56c2d83926c46deb50857d3f"`);
        await queryRunner.query(`DROP INDEX "IDX_9d1e1ed9661e19183e183f4828"`);
        await queryRunner.query(`ALTER TABLE "mail_messages" RENAME TO "temporary_mail_messages"`);
        await queryRunner.query(`CREATE TABLE "mail_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "gmailMessageId" varchar NOT NULL, "gmailThreadId" varchar NOT NULL, "gmailDraftId" varchar NOT NULL DEFAULT (''), "fromName" varchar NOT NULL DEFAULT (''), "fromEmail" varchar NOT NULL DEFAULT (''), "toEmails" text NOT NULL DEFAULT (''), "ccEmails" text NOT NULL DEFAULT (''), "bccEmails" text NOT NULL DEFAULT (''), "subject" varchar NOT NULL DEFAULT (''), "snippet" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "bodyHtml" text NOT NULL DEFAULT (''), "labelIds" text NOT NULL DEFAULT (''), "sentAt" datetime, "messageIdHeader" varchar NOT NULL DEFAULT (''), "referencesHeader" text NOT NULL DEFAULT (''), "inReplyToHeader" varchar NOT NULL DEFAULT (''), "attachmentsJson" text NOT NULL DEFAULT ('[]'), "sizeEstimate" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "mail_messages"("id", "companyId", "accountId", "threadId", "gmailMessageId", "gmailThreadId", "gmailDraftId", "fromName", "fromEmail", "toEmails", "ccEmails", "bccEmails", "subject", "snippet", "bodyText", "bodyHtml", "labelIds", "sentAt", "messageIdHeader", "referencesHeader", "inReplyToHeader", "attachmentsJson", "sizeEstimate", "createdAt", "updatedAt") SELECT "id", "companyId", "accountId", "threadId", "gmailMessageId", "gmailThreadId", "gmailDraftId", "fromName", "fromEmail", "toEmails", "ccEmails", "bccEmails", "subject", "snippet", "bodyText", "bodyHtml", "labelIds", "sentAt", "messageIdHeader", "referencesHeader", "inReplyToHeader", "attachmentsJson", "sizeEstimate", "createdAt", "updatedAt" FROM "temporary_mail_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_mail_messages"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9236dc41f28e0328f85094c8e4" ON "mail_messages" ("accountId", "gmailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2f56c2d83926c46deb50857d3f" ON "mail_messages" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9d1e1ed9661e19183e183f4828" ON "mail_messages" ("companyId") `);
    }

}
