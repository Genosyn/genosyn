import { MigrationInterface, QueryRunner } from "typeorm";

export class M19FinancePhaseG1780900000000 implements MigrationInterface {
    name = 'M19FinancePhaseG1780900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vendors" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "address" text NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_d6fe85814834ca5f5f70e2042f" ON "vendors" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c678184e5c58c4708eea1a8590" ON "vendors" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "bills" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "vendorId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "vendorRef" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "receivedAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_dd82cfc70a3e30db99e7ceaceb" ON "bills" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_fb5343824c5f833ea767f625f6" ON "bills" ("companyId", "vendorId") `);
        await queryRunner.query(`CREATE INDEX "IDX_87ea4aee01917a409a39006444" ON "bills" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ba12d2ba81b128da79832c3536" ON "bills" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "bill_line_items" ("id" varchar PRIMARY KEY NOT NULL, "billId" varchar NOT NULL, "expenseAccountId" varchar, "description" varchar NOT NULL, "quantity" real NOT NULL DEFAULT (1), "unitPriceCents" integer NOT NULL DEFAULT (0), "taxRateId" varchar, "taxName" varchar NOT NULL DEFAULT (''), "taxPercent" real NOT NULL DEFAULT (0), "taxInclusive" boolean NOT NULL DEFAULT (0), "lineSubtotalCents" integer NOT NULL DEFAULT (0), "lineTaxCents" integer NOT NULL DEFAULT (0), "lineTotalCents" integer NOT NULL DEFAULT (0), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_02728b414d250e086aef8a428b" ON "bill_line_items" ("billId") `);
        await queryRunner.query(`CREATE TABLE "bill_payments" ("id" varchar PRIMARY KEY NOT NULL, "billId" varchar NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "paidAt" datetime NOT NULL, "method" varchar NOT NULL DEFAULT ('other'), "reference" varchar NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a65275724feec10c30bed44704" ON "bill_payments" ("billId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a65275724feec10c30bed44704"`);
        await queryRunner.query(`DROP TABLE "bill_payments"`);
        await queryRunner.query(`DROP INDEX "IDX_02728b414d250e086aef8a428b"`);
        await queryRunner.query(`DROP TABLE "bill_line_items"`);
        await queryRunner.query(`DROP INDEX "IDX_ba12d2ba81b128da79832c3536"`);
        await queryRunner.query(`DROP INDEX "IDX_87ea4aee01917a409a39006444"`);
        await queryRunner.query(`DROP INDEX "IDX_fb5343824c5f833ea767f625f6"`);
        await queryRunner.query(`DROP INDEX "IDX_dd82cfc70a3e30db99e7ceaceb"`);
        await queryRunner.query(`DROP TABLE "bills"`);
        await queryRunner.query(`DROP INDEX "IDX_c678184e5c58c4708eea1a8590"`);
        await queryRunner.query(`DROP INDEX "IDX_d6fe85814834ca5f5f70e2042f"`);
        await queryRunner.query(`DROP TABLE "vendors"`);
    }

}
