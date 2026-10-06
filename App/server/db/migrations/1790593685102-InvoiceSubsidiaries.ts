import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceSubsidiaries1790593685102 implements MigrationInterface {
    name = 'InvoiceSubsidiaries1790593685102'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "subsidiaries" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "address" text NOT NULL DEFAULT (''), "country" varchar NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "registrationNumber" varchar NOT NULL DEFAULT (''), "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "website" varchar NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "archived" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2988d6bf38e905567277492d73" ON "subsidiaries" ("companyId", "archived") `);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`CREATE TABLE "temporary_invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "creditedCents" integer NOT NULL DEFAULT (0), "writtenOffCents" integer NOT NULL DEFAULT (0), "subsidiaryId" varchar, "issuerSnapshot" text)`);
        await queryRunner.query(`INSERT INTO "temporary_invoices"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents" FROM "invoices"`);
        await queryRunner.query(`DROP TABLE "invoices"`);
        await queryRunner.query(`ALTER TABLE "temporary_invoices" RENAME TO "invoices"`);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_7e659c93d19a0d00b17a3cb47f"`);
        await queryRunner.query(`DROP INDEX "IDX_3d4c08173d626b3f7c22b2f251"`);
        await queryRunner.query(`DROP INDEX "IDX_4dd25c6fdfc989fa3bf6b0e1dd"`);
        await queryRunner.query(`DROP INDEX "IDX_f53af82436c43379d715fb5b2b"`);
        await queryRunner.query(`CREATE TABLE "temporary_recurring_invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "name" varchar NOT NULL, "cronExpr" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "daysUntilDue" integer NOT NULL DEFAULT (14), "autoSend" boolean NOT NULL DEFAULT (0), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "lastRunAt" datetime, "lastInvoiceSlug" varchar NOT NULL DEFAULT (''), "runsCreated" integer NOT NULL DEFAULT (0), "maxRuns" integer, "endsOn" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "frequency" varchar NOT NULL DEFAULT ('monthly'), "intervalCount" integer NOT NULL DEFAULT (1), "anchorAt" datetime, "subsidiaryId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_recurring_invoices"("id", "companyId", "customerId", "slug", "name", "cronExpr", "status", "daysUntilDue", "autoSend", "currency", "notes", "footer", "nextRunAt", "lastRunAt", "lastInvoiceSlug", "runsCreated", "maxRuns", "endsOn", "createdById", "createdAt", "updatedAt", "frequency", "intervalCount", "anchorAt") SELECT "id", "companyId", "customerId", "slug", "name", "cronExpr", "status", "daysUntilDue", "autoSend", "currency", "notes", "footer", "nextRunAt", "lastRunAt", "lastInvoiceSlug", "runsCreated", "maxRuns", "endsOn", "createdById", "createdAt", "updatedAt", "frequency", "intervalCount", "anchorAt" FROM "recurring_invoices"`);
        await queryRunner.query(`DROP TABLE "recurring_invoices"`);
        await queryRunner.query(`ALTER TABLE "temporary_recurring_invoices" RENAME TO "recurring_invoices"`);
        await queryRunner.query(`CREATE INDEX "IDX_7e659c93d19a0d00b17a3cb47f" ON "recurring_invoices" ("status", "nextRunAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3d4c08173d626b3f7c22b2f251" ON "recurring_invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4dd25c6fdfc989fa3bf6b0e1dd" ON "recurring_invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f53af82436c43379d715fb5b2b" ON "recurring_invoices" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_50e84f6fc9a247ab896845267d"`);
        await queryRunner.query(`DROP INDEX "IDX_e7147292a569a965ecb2134236"`);
        await queryRunner.query(`DROP INDEX "IDX_4b554f95e27e5ed7ef3c8a8401"`);
        await queryRunner.query(`DROP INDEX "IDX_a369800c9ccabeb4e8eb527d52"`);
        await queryRunner.query(`CREATE TABLE "temporary_estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "subsidiaryId" varchar, "issuerSnapshot" text)`);
        await queryRunner.query(`INSERT INTO "temporary_estimates"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt" FROM "estimates"`);
        await queryRunner.query(`DROP TABLE "estimates"`);
        await queryRunner.query(`ALTER TABLE "temporary_estimates" RENAME TO "estimates"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50e84f6fc9a247ab896845267d" ON "estimates" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7147292a569a965ecb2134236" ON "estimates" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b554f95e27e5ed7ef3c8a8401" ON "estimates" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a369800c9ccabeb4e8eb527d52" ON "estimates" ("companyId", "numberSeq") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a369800c9ccabeb4e8eb527d52"`);
        await queryRunner.query(`DROP INDEX "IDX_4b554f95e27e5ed7ef3c8a8401"`);
        await queryRunner.query(`DROP INDEX "IDX_e7147292a569a965ecb2134236"`);
        await queryRunner.query(`DROP INDEX "IDX_50e84f6fc9a247ab896845267d"`);
        await queryRunner.query(`ALTER TABLE "estimates" RENAME TO "temporary_estimates"`);
        await queryRunner.query(`CREATE TABLE "estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "estimates"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt" FROM "temporary_estimates"`);
        await queryRunner.query(`DROP TABLE "temporary_estimates"`);
        await queryRunner.query(`CREATE INDEX "IDX_a369800c9ccabeb4e8eb527d52" ON "estimates" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b554f95e27e5ed7ef3c8a8401" ON "estimates" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7147292a569a965ecb2134236" ON "estimates" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50e84f6fc9a247ab896845267d" ON "estimates" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_f53af82436c43379d715fb5b2b"`);
        await queryRunner.query(`DROP INDEX "IDX_4dd25c6fdfc989fa3bf6b0e1dd"`);
        await queryRunner.query(`DROP INDEX "IDX_3d4c08173d626b3f7c22b2f251"`);
        await queryRunner.query(`DROP INDEX "IDX_7e659c93d19a0d00b17a3cb47f"`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" RENAME TO "temporary_recurring_invoices"`);
        await queryRunner.query(`CREATE TABLE "recurring_invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "name" varchar NOT NULL, "cronExpr" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "daysUntilDue" integer NOT NULL DEFAULT (14), "autoSend" boolean NOT NULL DEFAULT (0), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "lastRunAt" datetime, "lastInvoiceSlug" varchar NOT NULL DEFAULT (''), "runsCreated" integer NOT NULL DEFAULT (0), "maxRuns" integer, "endsOn" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "frequency" varchar NOT NULL DEFAULT ('monthly'), "intervalCount" integer NOT NULL DEFAULT (1), "anchorAt" datetime)`);
        await queryRunner.query(`INSERT INTO "recurring_invoices"("id", "companyId", "customerId", "slug", "name", "cronExpr", "status", "daysUntilDue", "autoSend", "currency", "notes", "footer", "nextRunAt", "lastRunAt", "lastInvoiceSlug", "runsCreated", "maxRuns", "endsOn", "createdById", "createdAt", "updatedAt", "frequency", "intervalCount", "anchorAt") SELECT "id", "companyId", "customerId", "slug", "name", "cronExpr", "status", "daysUntilDue", "autoSend", "currency", "notes", "footer", "nextRunAt", "lastRunAt", "lastInvoiceSlug", "runsCreated", "maxRuns", "endsOn", "createdById", "createdAt", "updatedAt", "frequency", "intervalCount", "anchorAt" FROM "temporary_recurring_invoices"`);
        await queryRunner.query(`DROP TABLE "temporary_recurring_invoices"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f53af82436c43379d715fb5b2b" ON "recurring_invoices" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_4dd25c6fdfc989fa3bf6b0e1dd" ON "recurring_invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_3d4c08173d626b3f7c22b2f251" ON "recurring_invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7e659c93d19a0d00b17a3cb47f" ON "recurring_invoices" ("status", "nextRunAt") `);
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`ALTER TABLE "invoices" RENAME TO "temporary_invoices"`);
        await queryRunner.query(`CREATE TABLE "invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "creditedCents" integer NOT NULL DEFAULT (0), "writtenOffCents" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "invoices"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents" FROM "temporary_invoices"`);
        await queryRunner.query(`DROP TABLE "temporary_invoices"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`DROP INDEX "IDX_2988d6bf38e905567277492d73"`);
        await queryRunner.query(`DROP TABLE "subsidiaries"`);
    }

}
