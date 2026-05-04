import { MigrationInterface, QueryRunner } from "typeorm";

export class M19FinancePhaseF1780800000000 implements MigrationInterface {
    name = 'M19FinancePhaseF1780800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "accounting_periods" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "startDate" datetime NOT NULL, "endDate" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('open'), "closedAt" datetime, "closedById" varchar, "closingEntryId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_d27859f80625f11e86e0afecff" ON "accounting_periods" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_138d0337c7fb52a70a61bf17f9" ON "accounting_periods" ("companyId", "startDate") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_138d0337c7fb52a70a61bf17f9"`);
        await queryRunner.query(`DROP INDEX "IDX_d27859f80625f11e86e0afecff"`);
        await queryRunner.query(`DROP TABLE "accounting_periods"`);
    }

}
