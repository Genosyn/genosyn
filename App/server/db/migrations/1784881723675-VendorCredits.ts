import { MigrationInterface, QueryRunner } from "typeorm";

export class VendorCredits1784881723675 implements MigrationInterface {
    name = 'VendorCredits1784881723675'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vendor_credits" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "vendorId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('issued'), "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "slug" varchar NOT NULL, "sourceBillId" varchar, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "homeSubtotalCents" integer NOT NULL DEFAULT (0), "homeTaxCents" integer NOT NULL DEFAULT (0), "homeTotalCents" integer NOT NULL DEFAULT (0), "appliedCents" integer NOT NULL DEFAULT (0), "homeAppliedCents" integer NOT NULL DEFAULT (0), "refundedCents" integer NOT NULL DEFAULT (0), "homeRefundedCents" integer NOT NULL DEFAULT (0), "reason" text NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "issueDate" datetime NOT NULL, "createdById" varchar, "issuedAt" datetime, "voidedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f04dafe5254d98eaeb2efb985f" ON "vendor_credits" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_96585f084b602d25d169ed412c" ON "vendor_credits" ("companyId", "sourceBillId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d594919b528133b8eeb4bcf5a3" ON "vendor_credits" ("companyId", "vendorId") `);
        await queryRunner.query(`CREATE INDEX "IDX_211ecfaab56d2d16b75d8c3e90" ON "vendor_credits" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "vendor_credit_lines" ("id" varchar PRIMARY KEY NOT NULL, "creditId" varchar NOT NULL, "expenseAccountId" varchar, "description" varchar NOT NULL, "quantity" real NOT NULL DEFAULT (1), "unitPriceCents" integer NOT NULL DEFAULT (0), "taxRateId" varchar, "taxName" varchar NOT NULL DEFAULT (''), "taxPercent" real NOT NULL DEFAULT (0), "taxInclusive" boolean NOT NULL DEFAULT (0), "lineSubtotalCents" integer NOT NULL DEFAULT (0), "lineTaxCents" integer NOT NULL DEFAULT (0), "lineTotalCents" integer NOT NULL DEFAULT (0), "homeSubtotalCents" integer NOT NULL DEFAULT (0), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_ac57f9b19ede57c093bff06293" ON "vendor_credit_lines" ("creditId") `);
        await queryRunner.query(`CREATE TABLE "vendor_credit_applications" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "creditId" varchar NOT NULL, "billId" varchar NOT NULL, "amountCents" integer NOT NULL, "apCents" integer NOT NULL, "creditCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT (0), "appliedAt" datetime NOT NULL, "createdById" varchar, "reversedAt" datetime, "reversedById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_13c040643556fb7f2805e322fa" ON "vendor_credit_applications" ("billId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c59ee63aa77ad1351133ab0dcb" ON "vendor_credit_applications" ("creditId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7b407b8fdfa6df95bee9f0dad3" ON "vendor_credit_applications" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "vendor_refunds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "creditId" varchar NOT NULL, "amountCents" integer NOT NULL, "creditCents" integer NOT NULL, "bankCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT (0), "currency" varchar NOT NULL, "bankAccountId" varchar NOT NULL, "refundedAt" datetime NOT NULL, "method" varchar NOT NULL DEFAULT (''), "reference" varchar NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "createdById" varchar, "reversedAt" datetime, "reversedById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f3dc03f5879fe237586d83aae4" ON "vendor_refunds" ("creditId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4d2896de218e1599555c296ba1" ON "vendor_refunds" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_ba12d2ba81b128da79832c3536"`);
        await queryRunner.query(`DROP INDEX "IDX_87ea4aee01917a409a39006444"`);
        await queryRunner.query(`DROP INDEX "IDX_fb5343824c5f833ea767f625f6"`);
        await queryRunner.query(`DROP INDEX "IDX_dd82cfc70a3e30db99e7ceaceb"`);
        await queryRunner.query(`CREATE TABLE "temporary_bills" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "vendorId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "vendorRef" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "receivedAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "creditedCents" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_bills"("id", "companyId", "vendorId", "slug", "numberSeq", "number", "vendorRef", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "receivedAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "vendorId", "slug", "numberSeq", "number", "vendorRef", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "receivedAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt" FROM "bills"`);
        await queryRunner.query(`DROP TABLE "bills"`);
        await queryRunner.query(`ALTER TABLE "temporary_bills" RENAME TO "bills"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ba12d2ba81b128da79832c3536" ON "bills" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_87ea4aee01917a409a39006444" ON "bills" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_fb5343824c5f833ea767f625f6" ON "bills" ("companyId", "vendorId") `);
        await queryRunner.query(`CREATE INDEX "IDX_dd82cfc70a3e30db99e7ceaceb" ON "bills" ("companyId", "numberSeq") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_dd82cfc70a3e30db99e7ceaceb"`);
        await queryRunner.query(`DROP INDEX "IDX_fb5343824c5f833ea767f625f6"`);
        await queryRunner.query(`DROP INDEX "IDX_87ea4aee01917a409a39006444"`);
        await queryRunner.query(`DROP INDEX "IDX_ba12d2ba81b128da79832c3536"`);
        await queryRunner.query(`ALTER TABLE "bills" RENAME TO "temporary_bills"`);
        await queryRunner.query(`CREATE TABLE "bills" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "vendorId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "vendorRef" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "dueDate" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "paidCents" integer NOT NULL DEFAULT (0), "balanceCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "receivedAt" datetime, "paidAt" datetime, "voidedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "bills"("id", "companyId", "vendorId", "slug", "numberSeq", "number", "vendorRef", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "receivedAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "vendorId", "slug", "numberSeq", "number", "vendorRef", "status", "issueDate", "dueDate", "currency", "subtotalCents", "taxCents", "totalCents", "paidCents", "balanceCents", "notes", "receivedAt", "paidAt", "voidedAt", "createdById", "createdAt", "updatedAt" FROM "temporary_bills"`);
        await queryRunner.query(`DROP TABLE "temporary_bills"`);
        await queryRunner.query(`CREATE INDEX "IDX_dd82cfc70a3e30db99e7ceaceb" ON "bills" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_fb5343824c5f833ea767f625f6" ON "bills" ("companyId", "vendorId") `);
        await queryRunner.query(`CREATE INDEX "IDX_87ea4aee01917a409a39006444" ON "bills" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ba12d2ba81b128da79832c3536" ON "bills" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_4d2896de218e1599555c296ba1"`);
        await queryRunner.query(`DROP INDEX "IDX_f3dc03f5879fe237586d83aae4"`);
        await queryRunner.query(`DROP TABLE "vendor_refunds"`);
        await queryRunner.query(`DROP INDEX "IDX_7b407b8fdfa6df95bee9f0dad3"`);
        await queryRunner.query(`DROP INDEX "IDX_c59ee63aa77ad1351133ab0dcb"`);
        await queryRunner.query(`DROP INDEX "IDX_13c040643556fb7f2805e322fa"`);
        await queryRunner.query(`DROP TABLE "vendor_credit_applications"`);
        await queryRunner.query(`DROP INDEX "IDX_ac57f9b19ede57c093bff06293"`);
        await queryRunner.query(`DROP TABLE "vendor_credit_lines"`);
        await queryRunner.query(`DROP INDEX "IDX_211ecfaab56d2d16b75d8c3e90"`);
        await queryRunner.query(`DROP INDEX "IDX_d594919b528133b8eeb4bcf5a3"`);
        await queryRunner.query(`DROP INDEX "IDX_96585f084b602d25d169ed412c"`);
        await queryRunner.query(`DROP INDEX "IDX_f04dafe5254d98eaeb2efb985f"`);
        await queryRunner.query(`DROP TABLE "vendor_credits"`);
    }

}
