import { MigrationInterface, QueryRunner } from "typeorm";

export class M19RecurringInvoices1781900000000 implements MigrationInterface {
    name = 'M19RecurringInvoices1781900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "recurring_invoices" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "name" varchar NOT NULL, "cronExpr" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "daysUntilDue" integer NOT NULL DEFAULT (14), "autoSend" boolean NOT NULL DEFAULT (0), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "lastRunAt" datetime, "lastInvoiceSlug" varchar NOT NULL DEFAULT (''), "runsCreated" integer NOT NULL DEFAULT (0), "maxRuns" integer, "endsOn" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7e659c93d19a0d00b17a3cb47f" ON "recurring_invoices" ("status", "nextRunAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3d4c08173d626b3f7c22b2f251" ON "recurring_invoices" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4dd25c6fdfc989fa3bf6b0e1dd" ON "recurring_invoices" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f53af82436c43379d715fb5b2b" ON "recurring_invoices" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "recurring_invoice_line_items" ("id" varchar PRIMARY KEY NOT NULL, "recurringInvoiceId" varchar NOT NULL, "productId" varchar, "description" varchar NOT NULL, "quantity" real NOT NULL DEFAULT (1), "unitPriceCents" integer NOT NULL DEFAULT (0), "taxRateId" varchar, "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_08115b7bd475f8408639498ac2" ON "recurring_invoice_line_items" ("recurringInvoiceId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_08115b7bd475f8408639498ac2"`);
        await queryRunner.query(`DROP TABLE "recurring_invoice_line_items"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_f53af82436c43379d715fb5b2b"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_4dd25c6fdfc989fa3bf6b0e1dd"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_3d4c08173d626b3f7c22b2f251"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_7e659c93d19a0d00b17a3cb47f"`);
        await queryRunner.query(`DROP TABLE "recurring_invoices"`);
    }

}
