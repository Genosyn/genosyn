import { MigrationInterface, QueryRunner } from "typeorm";

export class M19FinancePhaseE1780700000000 implements MigrationInterface {
    name = 'M19FinancePhaseE1780700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "currencies" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "code" varchar NOT NULL, "name" varchar NOT NULL, "symbol" varchar NOT NULL DEFAULT (''), "decimalPlaces" integer NOT NULL DEFAULT (2), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b9175282bda237f57f13322af2" ON "currencies" ("companyId", "code") `);
        await queryRunner.query(`CREATE TABLE "exchange_rates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "fromCurrency" varchar NOT NULL, "toCurrency" varchar NOT NULL, "date" datetime NOT NULL, "rate" real NOT NULL, "source" varchar NOT NULL DEFAULT ('manual'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_ae3bef7a3194ffed2cf62fe56f" ON "exchange_rates" ("companyId", "fromCurrency", "toCurrency") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_617c19e3a1794ed3934ebf18b1" ON "exchange_rates" ("companyId", "fromCurrency", "toCurrency", "date") `);
        await queryRunner.query(`CREATE TABLE "company_finance_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "homeCurrency" varchar NOT NULL DEFAULT ('USD'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7e4ecd4cb868e453e5cf8d7136" ON "company_finance_settings" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_d821017bf0365ffc14d10fec65"`);
        await queryRunner.query(`DROP INDEX "IDX_857badb2b30b781890a3d6190c"`);
        await queryRunner.query(`DROP INDEX "IDX_131649f21636a46d6f0913ba76"`);
        await queryRunner.query(`CREATE TABLE "temporary_ledger_lines" ("id" varchar PRIMARY KEY NOT NULL, "ledgerEntryId" varchar NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "debitCents" integer NOT NULL DEFAULT (0), "creditCents" integer NOT NULL DEFAULT (0), "description" varchar NOT NULL DEFAULT (''), "sortOrder" integer NOT NULL DEFAULT (0), "origCurrency" varchar NOT NULL DEFAULT (''), "origAmountCents" integer NOT NULL DEFAULT (0), "rate" real NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_ledger_lines"("id", "ledgerEntryId", "companyId", "accountId", "debitCents", "creditCents", "description", "sortOrder") SELECT "id", "ledgerEntryId", "companyId", "accountId", "debitCents", "creditCents", "description", "sortOrder" FROM "ledger_lines"`);
        await queryRunner.query(`DROP TABLE "ledger_lines"`);
        await queryRunner.query(`ALTER TABLE "temporary_ledger_lines" RENAME TO "ledger_lines"`);
        await queryRunner.query(`CREATE INDEX "IDX_d821017bf0365ffc14d10fec65" ON "ledger_lines" ("ledgerEntryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_857badb2b30b781890a3d6190c" ON "ledger_lines" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_131649f21636a46d6f0913ba76" ON "ledger_lines" ("companyId", "accountId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_131649f21636a46d6f0913ba76"`);
        await queryRunner.query(`DROP INDEX "IDX_857badb2b30b781890a3d6190c"`);
        await queryRunner.query(`DROP INDEX "IDX_d821017bf0365ffc14d10fec65"`);
        await queryRunner.query(`ALTER TABLE "ledger_lines" RENAME TO "temporary_ledger_lines"`);
        await queryRunner.query(`CREATE TABLE "ledger_lines" ("id" varchar PRIMARY KEY NOT NULL, "ledgerEntryId" varchar NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "debitCents" integer NOT NULL DEFAULT (0), "creditCents" integer NOT NULL DEFAULT (0), "description" varchar NOT NULL DEFAULT (''), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "ledger_lines"("id", "ledgerEntryId", "companyId", "accountId", "debitCents", "creditCents", "description", "sortOrder") SELECT "id", "ledgerEntryId", "companyId", "accountId", "debitCents", "creditCents", "description", "sortOrder" FROM "temporary_ledger_lines"`);
        await queryRunner.query(`DROP TABLE "temporary_ledger_lines"`);
        await queryRunner.query(`CREATE INDEX "IDX_131649f21636a46d6f0913ba76" ON "ledger_lines" ("companyId", "accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_857badb2b30b781890a3d6190c" ON "ledger_lines" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d821017bf0365ffc14d10fec65" ON "ledger_lines" ("ledgerEntryId") `);
        await queryRunner.query(`DROP INDEX "IDX_7e4ecd4cb868e453e5cf8d7136"`);
        await queryRunner.query(`DROP TABLE "company_finance_settings"`);
        await queryRunner.query(`DROP INDEX "IDX_617c19e3a1794ed3934ebf18b1"`);
        await queryRunner.query(`DROP INDEX "IDX_ae3bef7a3194ffed2cf62fe56f"`);
        await queryRunner.query(`DROP TABLE "exchange_rates"`);
        await queryRunner.query(`DROP INDEX "IDX_b9175282bda237f57f13322af2"`);
        await queryRunner.query(`DROP TABLE "currencies"`);
    }

}
