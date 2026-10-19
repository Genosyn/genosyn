import { MigrationInterface, QueryRunner } from "typeorm";

export class DocumentDiscounts1792385802779 implements MigrationInterface {
    name = 'DocumentDiscounts1792385802779'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`CREATE TABLE "temporary_invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "creditedCents" integer NOT NULL DEFAULT (0), "writtenOffCents" integer NOT NULL DEFAULT (0), "subsidiaryId" varchar, "issuerSnapshot" text, "discountPercent" real NOT NULL DEFAULT (0), "discountAmountCents" integer NOT NULL DEFAULT (0), "discountCents" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_invoices"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents", "subsidiaryId", "issuerSnapshot") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents", "subsidiaryId", "issuerSnapshot" FROM "invoices"`);
        await queryRunner.query(`DROP TABLE "invoices"`);
        await queryRunner.query(`ALTER TABLE "temporary_invoices" RENAME TO "invoices"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`DROP INDEX "IDX_a94ef2010066bdd4de59c22062"`);
        await queryRunner.query(`DROP INDEX "IDX_50e84f6fc9a247ab896845267d"`);
        await queryRunner.query(`DROP INDEX "IDX_e7147292a569a965ecb2134236"`);
        await queryRunner.query(`DROP INDEX "IDX_4b554f95e27e5ed7ef3c8a8401"`);
        await queryRunner.query(`DROP INDEX "IDX_a369800c9ccabeb4e8eb527d52"`);
        await queryRunner.query(`CREATE TABLE "temporary_estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "subsidiaryId" varchar, "issuerSnapshot" text, "archivedAt" datetime, "discountPercent" real NOT NULL DEFAULT (0), "discountAmountCents" integer NOT NULL DEFAULT (0), "discountCents" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_estimates"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot", "archivedAt") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot", "archivedAt" FROM "estimates"`);
        await queryRunner.query(`DROP TABLE "estimates"`);
        await queryRunner.query(`ALTER TABLE "temporary_estimates" RENAME TO "estimates"`);
        await queryRunner.query(`CREATE INDEX "IDX_a94ef2010066bdd4de59c22062" ON "estimates" ("companyId", "archivedAt") `);
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
        await queryRunner.query(`DROP INDEX "IDX_a94ef2010066bdd4de59c22062"`);
        await queryRunner.query(`ALTER TABLE "estimates" RENAME TO "temporary_estimates"`);
        await queryRunner.query(`CREATE TABLE "estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "subsidiaryId" varchar, "issuerSnapshot" text, "archivedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "estimates"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot", "archivedAt") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot", "archivedAt" FROM "temporary_estimates"`);
        await queryRunner.query(`DROP TABLE "temporary_estimates"`);
        await queryRunner.query(`CREATE INDEX "IDX_a369800c9ccabeb4e8eb527d52" ON "estimates" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b554f95e27e5ed7ef3c8a8401" ON "estimates" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7147292a569a965ecb2134236" ON "estimates" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50e84f6fc9a247ab896845267d" ON "estimates" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_a94ef2010066bdd4de59c22062" ON "estimates" ("companyId", "archivedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`ALTER TABLE "invoices" RENAME TO "temporary_invoices"`);
        await queryRunner.query(`CREATE TABLE "invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "creditedCents" integer NOT NULL DEFAULT (0), "writtenOffCents" integer NOT NULL DEFAULT (0), "subsidiaryId" varchar, "issuerSnapshot" text)`);
        await queryRunner.query(`INSERT INTO "invoices"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents", "subsidiaryId", "issuerSnapshot") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt", "creditedCents", "writtenOffCents", "subsidiaryId", "issuerSnapshot" FROM "temporary_invoices"`);
        await queryRunner.query(`DROP TABLE "temporary_invoices"`);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
    }

}
