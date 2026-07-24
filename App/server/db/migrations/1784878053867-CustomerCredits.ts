import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerCredits1784878053867 implements MigrationInterface {
    name = 'CustomerCredits1784878053867'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_credits" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "kind" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('draft'), "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "slug" varchar NOT NULL, "sourceInvoiceId" varchar, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "homeSubtotalCents" integer NOT NULL DEFAULT (0), "homeTaxCents" integer NOT NULL DEFAULT (0), "homeTotalCents" integer NOT NULL DEFAULT (0), "appliedCents" integer NOT NULL DEFAULT (0), "homeAppliedCents" integer NOT NULL DEFAULT (0), "refundedCents" integer NOT NULL DEFAULT (0), "homeRefundedCents" integer NOT NULL DEFAULT (0), "reason" text NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "issueDate" datetime NOT NULL, "createdById" varchar, "issuedAt" datetime, "voidedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1bdf3795998d0d80ca0245244f" ON "customer_credits" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_698deae864a29b4c13ee921714" ON "customer_credits" ("companyId", "sourceInvoiceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_da5b5c44a070e24b4e6efabe93" ON "customer_credits" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_866f402a33b312cf033602e8ce" ON "customer_credits" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "customer_credit_lines" ("id" varchar PRIMARY KEY NOT NULL, "creditId" varchar NOT NULL, "productId" varchar, "description" varchar NOT NULL, "quantity" real NOT NULL DEFAULT (1), "unitPriceCents" integer NOT NULL DEFAULT (0), "taxRateId" varchar, "taxName" varchar NOT NULL DEFAULT (''), "taxPercent" real NOT NULL DEFAULT (0), "taxInclusive" boolean NOT NULL DEFAULT (0), "lineSubtotalCents" integer NOT NULL DEFAULT (0), "lineTaxCents" integer NOT NULL DEFAULT (0), "lineTotalCents" integer NOT NULL DEFAULT (0), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_c8259acf63e53c0a512297a32f" ON "customer_credit_lines" ("creditId") `);
        await queryRunner.query(`CREATE TABLE "customer_credit_applications" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "creditId" varchar NOT NULL, "invoiceId" varchar NOT NULL, "amountCents" integer NOT NULL, "arCents" integer NOT NULL, "creditCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT (0), "appliedAt" datetime NOT NULL, "createdById" varchar, "reversedAt" datetime, "reversedById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_56fb532608428c0f7982aa1b87" ON "customer_credit_applications" ("invoiceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_82f84acd2774a6f7d234189f0c" ON "customer_credit_applications" ("creditId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ae713fb0e03797b75668f24147" ON "customer_credit_applications" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ae713fb0e03797b75668f24147"`);
        await queryRunner.query(`DROP INDEX "IDX_82f84acd2774a6f7d234189f0c"`);
        await queryRunner.query(`DROP INDEX "IDX_56fb532608428c0f7982aa1b87"`);
        await queryRunner.query(`DROP TABLE "customer_credit_applications"`);
        await queryRunner.query(`DROP INDEX "IDX_c8259acf63e53c0a512297a32f"`);
        await queryRunner.query(`DROP TABLE "customer_credit_lines"`);
        await queryRunner.query(`DROP INDEX "IDX_866f402a33b312cf033602e8ce"`);
        await queryRunner.query(`DROP INDEX "IDX_da5b5c44a070e24b4e6efabe93"`);
        await queryRunner.query(`DROP INDEX "IDX_698deae864a29b4c13ee921714"`);
        await queryRunner.query(`DROP INDEX "IDX_1bdf3795998d0d80ca0245244f"`);
        await queryRunner.query(`DROP TABLE "customer_credits"`);
    }

}
