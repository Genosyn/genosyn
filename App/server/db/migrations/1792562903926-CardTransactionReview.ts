import { MigrationInterface, QueryRunner } from "typeorm";

export class CardTransactionReview1792562903926 implements MigrationInterface {
    name = 'CardTransactionReview1792562903926'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b0c32a6348a11143070d72fc50"`);
        await queryRunner.query(`DROP INDEX "IDX_599e45cb60c91d126921b11500"`);
        await queryRunner.query(`DROP INDEX "IDX_91b18747b58da91aaf799b508f"`);
        await queryRunner.query(`CREATE TABLE "temporary_card_transactions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "feedId" varchar NOT NULL, "externalId" varchar NOT NULL, "cardId" varchar, "postedAt" datetime NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "description" varchar NOT NULL DEFAULT (''), "providerType" varchar NOT NULL DEFAULT (''), "accountingKind" varchar NOT NULL, "expenseAccountId" varchar, "ledgerEntryId" varchar, "postingError" text NOT NULL DEFAULT (''), "raw" text NOT NULL DEFAULT (''), "reclassifiedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "needsReview" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_card_transactions"("id", "companyId", "feedId", "externalId", "cardId", "postedAt", "amountCents", "currency", "description", "providerType", "accountingKind", "expenseAccountId", "ledgerEntryId", "postingError", "raw", "reclassifiedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "feedId", "externalId", "cardId", "postedAt", "amountCents", "currency", "description", "providerType", "accountingKind", "expenseAccountId", "ledgerEntryId", "postingError", "raw", "reclassifiedAt", "createdAt", "updatedAt" FROM "card_transactions"`);
        await queryRunner.query(`DROP TABLE "card_transactions"`);
        await queryRunner.query(`ALTER TABLE "temporary_card_transactions" RENAME TO "card_transactions"`);
        await queryRunner.query(`CREATE INDEX "IDX_b0c32a6348a11143070d72fc50" ON "card_transactions" ("feedId") `);
        await queryRunner.query(`CREATE INDEX "IDX_599e45cb60c91d126921b11500" ON "card_transactions" ("companyId", "feedId", "postedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91b18747b58da91aaf799b508f" ON "card_transactions" ("feedId", "externalId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_91b18747b58da91aaf799b508f"`);
        await queryRunner.query(`DROP INDEX "IDX_599e45cb60c91d126921b11500"`);
        await queryRunner.query(`DROP INDEX "IDX_b0c32a6348a11143070d72fc50"`);
        await queryRunner.query(`ALTER TABLE "card_transactions" RENAME TO "temporary_card_transactions"`);
        await queryRunner.query(`CREATE TABLE "card_transactions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "feedId" varchar NOT NULL, "externalId" varchar NOT NULL, "cardId" varchar, "postedAt" datetime NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "description" varchar NOT NULL DEFAULT (''), "providerType" varchar NOT NULL DEFAULT (''), "accountingKind" varchar NOT NULL, "expenseAccountId" varchar, "ledgerEntryId" varchar, "postingError" text NOT NULL DEFAULT (''), "raw" text NOT NULL DEFAULT (''), "reclassifiedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "card_transactions"("id", "companyId", "feedId", "externalId", "cardId", "postedAt", "amountCents", "currency", "description", "providerType", "accountingKind", "expenseAccountId", "ledgerEntryId", "postingError", "raw", "reclassifiedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "feedId", "externalId", "cardId", "postedAt", "amountCents", "currency", "description", "providerType", "accountingKind", "expenseAccountId", "ledgerEntryId", "postingError", "raw", "reclassifiedAt", "createdAt", "updatedAt" FROM "temporary_card_transactions"`);
        await queryRunner.query(`DROP TABLE "temporary_card_transactions"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91b18747b58da91aaf799b508f" ON "card_transactions" ("feedId", "externalId") `);
        await queryRunner.query(`CREATE INDEX "IDX_599e45cb60c91d126921b11500" ON "card_transactions" ("companyId", "feedId", "postedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_b0c32a6348a11143070d72fc50" ON "card_transactions" ("feedId") `);
    }

}
