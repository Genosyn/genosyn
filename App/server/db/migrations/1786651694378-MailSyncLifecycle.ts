import { MigrationInterface, QueryRunner } from "typeorm";

export class MailSyncLifecycle1786651694378 implements MigrationInterface {
    name = 'MailSyncLifecycle1786651694378'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c"`);
        await queryRunner.query(`DROP INDEX "IDX_d30a1e4d808dccb9b90ea431aa"`);
        await queryRunner.query(`CREATE TABLE "temporary_mail_accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "address" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "statusMessage" varchar NOT NULL DEFAULT (''), "historyId" varchar NOT NULL DEFAULT (''), "lastSyncAt" datetime, "backfilledAt" datetime, "backfillPageToken" varchar NOT NULL DEFAULT (''), "backfilledCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "syncState" varchar NOT NULL DEFAULT ('idle'), "syncAttemptId" varchar, "syncStartedAt" datetime, "syncFinishedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_mail_accounts"("id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt") SELECT "id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt" FROM "mail_accounts"`);
        await queryRunner.query(`DROP TABLE "mail_accounts"`);
        await queryRunner.query(`ALTER TABLE "temporary_mail_accounts" RENAME TO "mail_accounts"`);
        await queryRunner.query(`CREATE INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c" ON "mail_accounts" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d30a1e4d808dccb9b90ea431aa" ON "mail_accounts" ("connectionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d30a1e4d808dccb9b90ea431aa"`);
        await queryRunner.query(`DROP INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" RENAME TO "temporary_mail_accounts"`);
        await queryRunner.query(`CREATE TABLE "mail_accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "address" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "statusMessage" varchar NOT NULL DEFAULT (''), "historyId" varchar NOT NULL DEFAULT (''), "lastSyncAt" datetime, "backfilledAt" datetime, "backfillPageToken" varchar NOT NULL DEFAULT (''), "backfilledCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "mail_accounts"("id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt") SELECT "id", "companyId", "connectionId", "address", "status", "statusMessage", "historyId", "lastSyncAt", "backfilledAt", "backfillPageToken", "backfilledCount", "createdByUserId", "createdAt", "updatedAt" FROM "temporary_mail_accounts"`);
        await queryRunner.query(`DROP TABLE "temporary_mail_accounts"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d30a1e4d808dccb9b90ea431aa" ON "mail_accounts" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e14ce68c3b10e0c7a6d5e5ef4c" ON "mail_accounts" ("companyId") `);
    }

}
