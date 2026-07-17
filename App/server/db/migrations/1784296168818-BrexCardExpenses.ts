import { MigrationInterface, QueryRunner } from "typeorm";

export class BrexCardExpenses1784296168818 implements MigrationInterface {
    name = 'BrexCardExpenses1784296168818'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "card_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar NOT NULL, "liabilityAccountId" varchar NOT NULL, "defaultExpenseAccountId" varchar NOT NULL, "paymentAccountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_881b7a9117fe5e209bf49fd6eb" ON "card_feeds" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5210084ac94fc63099b2dc1d9b" ON "card_feeds" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "card_transactions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "feedId" varchar NOT NULL, "externalId" varchar NOT NULL, "cardId" varchar, "postedAt" datetime NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "description" varchar NOT NULL DEFAULT (''), "providerType" varchar NOT NULL DEFAULT (''), "accountingKind" varchar NOT NULL, "expenseAccountId" varchar, "ledgerEntryId" varchar, "postingError" text NOT NULL DEFAULT (''), "raw" text NOT NULL DEFAULT (''), "reclassifiedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91b18747b58da91aaf799b508f" ON "card_transactions" ("feedId", "externalId") `);
        await queryRunner.query(`CREATE INDEX "IDX_599e45cb60c91d126921b11500" ON "card_transactions" ("companyId", "feedId", "postedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_b0c32a6348a11143070d72fc50" ON "card_transactions" ("feedId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b0c32a6348a11143070d72fc50"`);
        await queryRunner.query(`DROP INDEX "IDX_599e45cb60c91d126921b11500"`);
        await queryRunner.query(`DROP INDEX "IDX_91b18747b58da91aaf799b508f"`);
        await queryRunner.query(`DROP TABLE "card_transactions"`);
        await queryRunner.query(`DROP INDEX "IDX_5210084ac94fc63099b2dc1d9b"`);
        await queryRunner.query(`DROP INDEX "IDX_881b7a9117fe5e209bf49fd6eb"`);
        await queryRunner.query(`DROP TABLE "card_feeds"`);
    }

}
