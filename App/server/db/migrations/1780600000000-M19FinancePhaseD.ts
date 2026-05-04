import { MigrationInterface, QueryRunner } from "typeorm";

export class M19FinancePhaseD1780600000000 implements MigrationInterface {
    name = 'M19FinancePhaseD1780600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "bank_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar, "accountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_b5bc8dc3001a897c4d50e05720" ON "bank_feeds" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8981f153643ea13187e82d41e3" ON "bank_feeds" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "bank_transactions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "feedId" varchar NOT NULL, "externalId" varchar, "date" datetime NOT NULL, "amountCents" integer NOT NULL, "description" varchar NOT NULL DEFAULT (''), "reference" varchar NOT NULL DEFAULT (''), "raw" text NOT NULL DEFAULT (''), "matchedPaymentId" varchar, "matchedLedgerEntryId" varchar, "reconciledAt" datetime, "reconciledById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_bb323c24b475395a4d08805b87" ON "bank_transactions" ("feedId", "externalId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b22a3c009323ff797c672f15d6" ON "bank_transactions" ("companyId", "reconciledAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_dd9de51594085b276efe00ff2e" ON "bank_transactions" ("companyId", "feedId", "date") `);
        await queryRunner.query(`CREATE INDEX "IDX_c1517c32327ed32204813a5f4d" ON "bank_transactions" ("feedId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_c1517c32327ed32204813a5f4d"`);
        await queryRunner.query(`DROP INDEX "IDX_dd9de51594085b276efe00ff2e"`);
        await queryRunner.query(`DROP INDEX "IDX_b22a3c009323ff797c672f15d6"`);
        await queryRunner.query(`DROP INDEX "IDX_bb323c24b475395a4d08805b87"`);
        await queryRunner.query(`DROP TABLE "bank_transactions"`);
        await queryRunner.query(`DROP INDEX "IDX_8981f153643ea13187e82d41e3"`);
        await queryRunner.query(`DROP INDEX "IDX_b5bc8dc3001a897c4d50e05720"`);
        await queryRunner.query(`DROP TABLE "bank_feeds"`);
    }

}
