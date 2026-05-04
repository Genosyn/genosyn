import { MigrationInterface, QueryRunner } from "typeorm";

export class M19FinancePhaseB1780500000000 implements MigrationInterface {
    name = 'M19FinancePhaseB1780500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "code" varchar NOT NULL, "name" varchar NOT NULL, "type" varchar NOT NULL, "parentId" varchar, "isSystem" boolean NOT NULL DEFAULT (0), "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a28f4daf5e97e6474a84eb0ef5" ON "accounts" ("companyId", "type") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5c4d8213d09415425f957521eb" ON "accounts" ("companyId", "code") `);
        await queryRunner.query(`CREATE TABLE "ledger_entries" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "date" datetime NOT NULL, "memo" varchar NOT NULL DEFAULT (''), "source" varchar NOT NULL DEFAULT ('manual'), "sourceRefId" varchar, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a491c27dd948cdc988487949cf" ON "ledger_entries" ("companyId", "source", "sourceRefId") `);
        await queryRunner.query(`CREATE INDEX "IDX_bc48646cddb5934d0a8ea980d6" ON "ledger_entries" ("companyId", "date") `);
        await queryRunner.query(`CREATE TABLE "ledger_lines" ("id" varchar PRIMARY KEY NOT NULL, "ledgerEntryId" varchar NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "debitCents" integer NOT NULL DEFAULT (0), "creditCents" integer NOT NULL DEFAULT (0), "description" varchar NOT NULL DEFAULT (''), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_131649f21636a46d6f0913ba76" ON "ledger_lines" ("companyId", "accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_857badb2b30b781890a3d6190c" ON "ledger_lines" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d821017bf0365ffc14d10fec65" ON "ledger_lines" ("ledgerEntryId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d821017bf0365ffc14d10fec65"`);
        await queryRunner.query(`DROP INDEX "IDX_857badb2b30b781890a3d6190c"`);
        await queryRunner.query(`DROP INDEX "IDX_131649f21636a46d6f0913ba76"`);
        await queryRunner.query(`DROP TABLE "ledger_lines"`);
        await queryRunner.query(`DROP INDEX "IDX_bc48646cddb5934d0a8ea980d6"`);
        await queryRunner.query(`DROP INDEX "IDX_a491c27dd948cdc988487949cf"`);
        await queryRunner.query(`DROP TABLE "ledger_entries"`);
        await queryRunner.query(`DROP INDEX "IDX_5c4d8213d09415425f957521eb"`);
        await queryRunner.query(`DROP INDEX "IDX_a28f4daf5e97e6474a84eb0ef5"`);
        await queryRunner.query(`DROP TABLE "accounts"`);
    }

}
