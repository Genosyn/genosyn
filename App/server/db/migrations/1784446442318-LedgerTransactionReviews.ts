import { MigrationInterface, QueryRunner } from "typeorm";

export class LedgerTransactionReviews1784446442318 implements MigrationInterface {
    name = 'LedgerTransactionReviews1784446442318'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_bc48646cddb5934d0a8ea980d6"`);
        await queryRunner.query(`DROP INDEX "IDX_a491c27dd948cdc988487949cf"`);
        await queryRunner.query(`CREATE TABLE "temporary_ledger_entries" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "date" datetime NOT NULL, "memo" varchar NOT NULL DEFAULT (''), "source" varchar NOT NULL DEFAULT ('manual'), "sourceRefId" varchar, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "reviewStatus" varchar NOT NULL DEFAULT ('unreviewed'), "reviewChangesJson" text, "reviewNote" text, "reviewedByEmployeeId" varchar, "reviewedAt" datetime, "approvedById" varchar, "approvedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_ledger_entries"("id", "companyId", "date", "memo", "source", "sourceRefId", "createdById", "createdAt") SELECT "id", "companyId", "date", "memo", "source", "sourceRefId", "createdById", "createdAt" FROM "ledger_entries"`);
        await queryRunner.query(`DROP TABLE "ledger_entries"`);
        await queryRunner.query(`ALTER TABLE "temporary_ledger_entries" RENAME TO "ledger_entries"`);
        await queryRunner.query(`CREATE INDEX "IDX_bc48646cddb5934d0a8ea980d6" ON "ledger_entries" ("companyId", "date") `);
        await queryRunner.query(`CREATE INDEX "IDX_a491c27dd948cdc988487949cf" ON "ledger_entries" ("companyId", "source", "sourceRefId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8ccc4f0e9aa985ffedfcbce34c" ON "ledger_entries" ("companyId", "reviewStatus") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_8ccc4f0e9aa985ffedfcbce34c"`);
        await queryRunner.query(`DROP INDEX "IDX_a491c27dd948cdc988487949cf"`);
        await queryRunner.query(`DROP INDEX "IDX_bc48646cddb5934d0a8ea980d6"`);
        await queryRunner.query(`ALTER TABLE "ledger_entries" RENAME TO "temporary_ledger_entries"`);
        await queryRunner.query(`CREATE TABLE "ledger_entries" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "date" datetime NOT NULL, "memo" varchar NOT NULL DEFAULT (''), "source" varchar NOT NULL DEFAULT ('manual'), "sourceRefId" varchar, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "ledger_entries"("id", "companyId", "date", "memo", "source", "sourceRefId", "createdById", "createdAt") SELECT "id", "companyId", "date", "memo", "source", "sourceRefId", "createdById", "createdAt" FROM "temporary_ledger_entries"`);
        await queryRunner.query(`DROP TABLE "temporary_ledger_entries"`);
        await queryRunner.query(`CREATE INDEX "IDX_a491c27dd948cdc988487949cf" ON "ledger_entries" ("companyId", "source", "sourceRefId") `);
        await queryRunner.query(`CREATE INDEX "IDX_bc48646cddb5934d0a8ea980d6" ON "ledger_entries" ("companyId", "date") `);
    }

}
