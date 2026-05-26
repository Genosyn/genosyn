import { MigrationInterface, QueryRunner } from "typeorm";

export class FinanceTemplates1781800000000 implements MigrationInterface {
    name = 'FinanceTemplates1781800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7e4ecd4cb868e453e5cf8d7136"`);
        await queryRunner.query(`CREATE TABLE "temporary_company_finance_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "homeCurrency" varchar NOT NULL DEFAULT ('USD'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "defaultFromBlock" text NOT NULL DEFAULT (''), "defaultFooter" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_company_finance_settings"("id", "companyId", "homeCurrency", "createdAt", "updatedAt") SELECT "id", "companyId", "homeCurrency", "createdAt", "updatedAt" FROM "company_finance_settings"`);
        await queryRunner.query(`DROP TABLE "company_finance_settings"`);
        await queryRunner.query(`ALTER TABLE "temporary_company_finance_settings" RENAME TO "company_finance_settings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7e4ecd4cb868e453e5cf8d7136" ON "company_finance_settings" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7e4ecd4cb868e453e5cf8d7136"`);
        await queryRunner.query(`ALTER TABLE "company_finance_settings" RENAME TO "temporary_company_finance_settings"`);
        await queryRunner.query(`CREATE TABLE "company_finance_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "homeCurrency" varchar NOT NULL DEFAULT ('USD'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "company_finance_settings"("id", "companyId", "homeCurrency", "createdAt", "updatedAt") SELECT "id", "companyId", "homeCurrency", "createdAt", "updatedAt" FROM "temporary_company_finance_settings"`);
        await queryRunner.query(`DROP TABLE "temporary_company_finance_settings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7e4ecd4cb868e453e5cf8d7136" ON "company_finance_settings" ("companyId") `);
    }

}
