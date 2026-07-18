import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceAlwaysCc1784388931004 implements MigrationInterface {
    name = 'InvoiceAlwaysCc1784388931004'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7e4ecd4cb868e453e5cf8d7136"`);
        await queryRunner.query(`CREATE TABLE "temporary_company_finance_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "homeCurrency" varchar NOT NULL DEFAULT ('USD'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "defaultFromBlock" text NOT NULL DEFAULT (''), "defaultFooter" text NOT NULL DEFAULT (''), "invoiceCcEmails" text NOT NULL DEFAULT ('[]'))`);
        await queryRunner.query(`INSERT INTO "temporary_company_finance_settings"("id", "companyId", "homeCurrency", "createdAt", "updatedAt", "defaultFromBlock", "defaultFooter") SELECT "id", "companyId", "homeCurrency", "createdAt", "updatedAt", "defaultFromBlock", "defaultFooter" FROM "company_finance_settings"`);
        await queryRunner.query(`DROP TABLE "company_finance_settings"`);
        await queryRunner.query(`ALTER TABLE "temporary_company_finance_settings" RENAME TO "company_finance_settings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7e4ecd4cb868e453e5cf8d7136" ON "company_finance_settings" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7e4ecd4cb868e453e5cf8d7136"`);
        await queryRunner.query(`ALTER TABLE "company_finance_settings" RENAME TO "temporary_company_finance_settings"`);
        await queryRunner.query(`CREATE TABLE "company_finance_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "homeCurrency" varchar NOT NULL DEFAULT ('USD'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "defaultFromBlock" text NOT NULL DEFAULT (''), "defaultFooter" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "company_finance_settings"("id", "companyId", "homeCurrency", "createdAt", "updatedAt", "defaultFromBlock", "defaultFooter") SELECT "id", "companyId", "homeCurrency", "createdAt", "updatedAt", "defaultFromBlock", "defaultFooter" FROM "temporary_company_finance_settings"`);
        await queryRunner.query(`DROP TABLE "temporary_company_finance_settings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7e4ecd4cb868e453e5cf8d7136" ON "company_finance_settings" ("companyId") `);
    }

}
