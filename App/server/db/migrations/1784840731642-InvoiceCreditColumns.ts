import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceCreditColumns1784840731642 implements MigrationInterface {
    name = 'InvoiceCreditColumns1784840731642'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`CREATE TABLE "temporary_invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "creditedCents" integer NOT NULL DEFAULT (0), "writtenOffCents" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_invoices"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt" FROM "invoices"`);
        await queryRunner.query(`DROP TABLE "invoices"`);
        await queryRunner.query(`ALTER TABLE "temporary_invoices" RENAME TO "invoices"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`DROP INDEX "IDX_c1517c32327ed32204813a5f4d"`);
        await queryRunner.query(`DROP INDEX "IDX_dd9de51594085b276efe00ff2e"`);
        await queryRunner.query(`DROP INDEX "IDX_b22a3c009323ff797c672f15d6"`);
        await queryRunner.query(`DROP INDEX "IDX_bb323c24b475395a4d08805b87"`);
        await queryRunner.query(`CREATE TABLE "temporary_bank_transactions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "feedId" varchar NOT NULL, "externalId" varchar, "date" datetime NOT NULL, "amountCents" integer NOT NULL, "description" varchar NOT NULL DEFAULT (''), "reference" varchar NOT NULL DEFAULT (''), "raw" text NOT NULL DEFAULT (''), "matchedPaymentId" varchar, "matchedLedgerEntryId" varchar, "reconciledAt" datetime, "reconciledById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "matchedCreditId" varchar, "matchedRefundId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_bank_transactions"("id", "companyId", "feedId", "externalId", "date", "amountCents", "description", "reference", "raw", "matchedPaymentId", "matchedLedgerEntryId", "reconciledAt", "reconciledById", "createdAt") SELECT "id", "companyId", "feedId", "externalId", "date", "amountCents", "description", "reference", "raw", "matchedPaymentId", "matchedLedgerEntryId", "reconciledAt", "reconciledById", "createdAt" FROM "bank_transactions"`);
        await queryRunner.query(`DROP TABLE "bank_transactions"`);
        await queryRunner.query(`ALTER TABLE "temporary_bank_transactions" RENAME TO "bank_transactions"`);
        await queryRunner.query(`CREATE INDEX "IDX_c1517c32327ed32204813a5f4d" ON "bank_transactions" ("feedId") `);
        await queryRunner.query(`CREATE INDEX "IDX_dd9de51594085b276efe00ff2e" ON "bank_transactions" ("companyId", "feedId", "date") `);
        await queryRunner.query(`CREATE INDEX "IDX_b22a3c009323ff797c672f15d6" ON "bank_transactions" ("companyId", "reconciledAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bb323c24b475395a4d08805b87" ON "bank_transactions" ("feedId", "externalId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_bb323c24b475395a4d08805b87"`);
        await queryRunner.query(`DROP INDEX "IDX_b22a3c009323ff797c672f15d6"`);
        await queryRunner.query(`DROP INDEX "IDX_dd9de51594085b276efe00ff2e"`);
        await queryRunner.query(`DROP INDEX "IDX_c1517c32327ed32204813a5f4d"`);
        await queryRunner.query(`ALTER TABLE "bank_transactions" RENAME TO "temporary_bank_transactions"`);
        await queryRunner.query(`CREATE TABLE "bank_transactions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "feedId" varchar NOT NULL, "externalId" varchar, "date" datetime NOT NULL, "amountCents" integer NOT NULL, "description" varchar NOT NULL DEFAULT (''), "reference" varchar NOT NULL DEFAULT (''), "raw" text NOT NULL DEFAULT (''), "matchedPaymentId" varchar, "matchedLedgerEntryId" varchar, "reconciledAt" datetime, "reconciledById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "bank_transactions"("id", "companyId", "feedId", "externalId", "date", "amountCents", "description", "reference", "raw", "matchedPaymentId", "matchedLedgerEntryId", "reconciledAt", "reconciledById", "createdAt") SELECT "id", "companyId", "feedId", "externalId", "date", "amountCents", "description", "reference", "raw", "matchedPaymentId", "matchedLedgerEntryId", "reconciledAt", "reconciledById", "createdAt" FROM "temporary_bank_transactions"`);
        await queryRunner.query(`DROP TABLE "temporary_bank_transactions"`);
        await queryRunner.query(`CREATE INDEX "IDX_bb323c24b475395a4d08805b87" ON "bank_transactions" ("feedId", "externalId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b22a3c009323ff797c672f15d6" ON "bank_transactions" ("companyId", "reconciledAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_dd9de51594085b276efe00ff2e" ON "bank_transactions" ("companyId", "feedId", "date") `);
        await queryRunner.query(`CREATE INDEX "IDX_c1517c32327ed32204813a5f4d" ON "bank_transactions" ("feedId") `);
        await queryRunner.query(`DROP INDEX "IDX_1a8aa00285e3a99a1a1d751369"`);
        await queryRunner.query(`DROP INDEX "IDX_f73f492a1b636e2bfa2fea3cd6"`);
        await queryRunner.query(`DROP INDEX "IDX_f3ffc04f81b4de8bda218c8982"`);
        await queryRunner.query(`DROP INDEX "IDX_0afa115f708972afe8a7ec2d26"`);
        await queryRunner.query(`ALTER TABLE "invoices" RENAME TO "temporary_invoices"`);
        await queryRunner.query(`CREATE TABLE "invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "invoices"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "footer", "sentAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt" FROM "temporary_invoices"`);
        await queryRunner.query(`DROP TABLE "temporary_invoices"`);
        await queryRunner.query(`CREATE INDEX "IDX_1a8aa00285e3a99a1a1d751369" ON "invoices" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_f73f492a1b636e2bfa2fea3cd6" ON "invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3ffc04f81b4de8bda218c8982" ON "invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0afa115f708972afe8a7ec2d26" ON "invoices" ("companyId", "slug") `);
    }

}
