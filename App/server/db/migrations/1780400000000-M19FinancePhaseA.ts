import { MigrationInterface, QueryRunner } from "typeorm";

export class M19FinancePhaseA1780400000000 implements MigrationInterface {
    name = 'M19FinancePhaseA1780400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "billingAddress" text NOT NULL DEFAULT (''), "shippingAddress" text NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_8bc655492a3f2878a887a75b86" ON "customers" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e8ba264e557c27ffe461eb6c69" ON "customers" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "products" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "unitPriceCents" integer NOT NULL DEFAULT (0), "currency" varchar NOT NULL DEFAULT ('USD'), "defaultTaxRateId" varchar, "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_6537e40d536cc111b3fb99ec7b" ON "products" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_53d867140bc74d0fb238a29ed2" ON "products" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "tax_rates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "ratePercent" real NOT NULL DEFAULT (0), "inclusive" boolean NOT NULL DEFAULT (0), "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f0ba22e44ed96bd6b9892db29d" ON "tax_rates" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE TABLE "invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "invoice_line_items" ("id" varchar PRIMARY KEY NOT NULL, "invoiceId" varchar NOT NULL, "productId" varchar, "description" varchar NOT NULL, "quantity" real NOT NULL DEFAULT (1), "unitPriceCents" integer NOT NULL DEFAULT (0), "taxRateId" varchar, "taxName" varchar NOT NULL DEFAULT (''), "taxPercent" real NOT NULL DEFAULT (0), "taxInclusive" boolean NOT NULL DEFAULT (0), "lineSubtotalCents" integer NOT NULL DEFAULT (0), "lineTaxCents" integer NOT NULL DEFAULT (0), "lineTotalCents" integer NOT NULL DEFAULT (0), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_2ec8b1cda36ed79a7ded49bd91" ON "invoice_line_items" ("invoiceId") `);
        await queryRunner.query(`CREATE TABLE "invoice_payments" ("id" varchar PRIMARY KEY NOT NULL, "invoiceId" varchar NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "paidAt" datetime NOT NULL, "method" varchar NOT NULL DEFAULT ('other'), "reference" varchar NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_3b2a25d4269ebe9d7ca0c1001d" ON "invoice_payments" ("invoiceId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3b2a25d4269ebe9d7ca0c1001d"`);
        await queryRunner.query(`DROP TABLE "invoice_payments"`);
        await queryRunner.query(`DROP INDEX "IDX_2ec8b1cda36ed79a7ded49bd91"`);
        await queryRunner.query(`DROP TABLE "invoice_line_items"`);
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`DROP TABLE "invoices"`);
        await queryRunner.query(`DROP INDEX "IDX_f0ba22e44ed96bd6b9892db29d"`);
        await queryRunner.query(`DROP TABLE "tax_rates"`);
        await queryRunner.query(`DROP INDEX "IDX_53d867140bc74d0fb238a29ed2"`);
        await queryRunner.query(`DROP INDEX "IDX_6537e40d536cc111b3fb99ec7b"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DROP INDEX "IDX_e8ba264e557c27ffe461eb6c69"`);
        await queryRunner.query(`DROP INDEX "IDX_8bc655492a3f2878a887a75b86"`);
        await queryRunner.query(`DROP TABLE "customers"`);
    }

}
