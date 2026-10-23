import { MigrationInterface, QueryRunner } from "typeorm";

export class BankingSyncStatus1792770648647 implements MigrationInterface {
    name = 'BankingSyncStatus1792770648647'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b5bc8dc3001a897c4d50e05720"`);
        await queryRunner.query(`DROP INDEX "IDX_8981f153643ea13187e82d41e3"`);
        await queryRunner.query(`CREATE TABLE "temporary_bank_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar, "accountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "externalAccountId" varchar, "syncStartedAt" datetime, "lastSyncAttemptAt" datetime, "lastSyncError" varchar NOT NULL DEFAULT (''), "lastSyncErrorDetail" text NOT NULL DEFAULT (''), "lastSyncErrorKind" varchar NOT NULL DEFAULT (''), "syncFailureCount" integer NOT NULL DEFAULT (0), "nextSyncAt" datetime, "balanceCents" bigint, "balanceCurrency" varchar, "balanceAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_bank_feeds"("id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt", "externalAccountId") SELECT "id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt", "externalAccountId" FROM "bank_feeds"`);
        await queryRunner.query(`DROP TABLE "bank_feeds"`);
        await queryRunner.query(`ALTER TABLE "temporary_bank_feeds" RENAME TO "bank_feeds"`);
        await queryRunner.query(`CREATE INDEX "IDX_b5bc8dc3001a897c4d50e05720" ON "bank_feeds" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8981f153643ea13187e82d41e3" ON "bank_feeds" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_5210084ac94fc63099b2dc1d9b"`);
        await queryRunner.query(`DROP INDEX "IDX_881b7a9117fe5e209bf49fd6eb"`);
        await queryRunner.query(`CREATE TABLE "temporary_card_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar NOT NULL, "liabilityAccountId" varchar NOT NULL, "defaultExpenseAccountId" varchar NOT NULL, "paymentAccountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "syncStartedAt" datetime, "lastSyncAttemptAt" datetime, "lastSyncError" varchar NOT NULL DEFAULT (''), "lastSyncErrorDetail" text NOT NULL DEFAULT (''), "lastSyncErrorKind" varchar NOT NULL DEFAULT (''), "syncFailureCount" integer NOT NULL DEFAULT (0), "nextSyncAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_card_feeds"("id", "companyId", "name", "kind", "connectionId", "liabilityAccountId", "defaultExpenseAccountId", "paymentAccountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "kind", "connectionId", "liabilityAccountId", "defaultExpenseAccountId", "paymentAccountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt" FROM "card_feeds"`);
        await queryRunner.query(`DROP TABLE "card_feeds"`);
        await queryRunner.query(`ALTER TABLE "temporary_card_feeds" RENAME TO "card_feeds"`);
        await queryRunner.query(`CREATE INDEX "IDX_5210084ac94fc63099b2dc1d9b" ON "card_feeds" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_881b7a9117fe5e209bf49fd6eb" ON "card_feeds" ("companyId", "archivedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_881b7a9117fe5e209bf49fd6eb"`);
        await queryRunner.query(`DROP INDEX "IDX_5210084ac94fc63099b2dc1d9b"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" RENAME TO "temporary_card_feeds"`);
        await queryRunner.query(`CREATE TABLE "card_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar NOT NULL, "liabilityAccountId" varchar NOT NULL, "defaultExpenseAccountId" varchar NOT NULL, "paymentAccountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "card_feeds"("id", "companyId", "name", "kind", "connectionId", "liabilityAccountId", "defaultExpenseAccountId", "paymentAccountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "kind", "connectionId", "liabilityAccountId", "defaultExpenseAccountId", "paymentAccountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt" FROM "temporary_card_feeds"`);
        await queryRunner.query(`DROP TABLE "temporary_card_feeds"`);
        await queryRunner.query(`CREATE INDEX "IDX_881b7a9117fe5e209bf49fd6eb" ON "card_feeds" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5210084ac94fc63099b2dc1d9b" ON "card_feeds" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_8981f153643ea13187e82d41e3"`);
        await queryRunner.query(`DROP INDEX "IDX_b5bc8dc3001a897c4d50e05720"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" RENAME TO "temporary_bank_feeds"`);
        await queryRunner.query(`CREATE TABLE "bank_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar, "accountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "externalAccountId" varchar)`);
        await queryRunner.query(`INSERT INTO "bank_feeds"("id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt", "externalAccountId") SELECT "id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt", "externalAccountId" FROM "temporary_bank_feeds"`);
        await queryRunner.query(`DROP TABLE "temporary_bank_feeds"`);
        await queryRunner.query(`CREATE INDEX "IDX_8981f153643ea13187e82d41e3" ON "bank_feeds" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b5bc8dc3001a897c4d50e05720" ON "bank_feeds" ("companyId", "archivedAt") `);
    }

}
