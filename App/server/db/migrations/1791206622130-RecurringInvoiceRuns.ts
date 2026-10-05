import { MigrationInterface, QueryRunner } from "typeorm";

export class RecurringInvoiceRuns1791206622130 implements MigrationInterface {
    name = 'RecurringInvoiceRuns1791206622130'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "recurring_invoice_runs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "recurringInvoiceId" varchar NOT NULL, "scheduledFor" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "invoiceId" varchar, "attempts" integer NOT NULL DEFAULT (0), "emailAttempts" integer NOT NULL DEFAULT (0), "emailStatus" varchar NOT NULL DEFAULT (''), "retryAt" datetime, "lockedUntil" datetime, "lastError" text NOT NULL DEFAULT (''), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_64d6098cc80f05d629ea086666" ON "recurring_invoice_runs" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4603b70f611605f6255c1e8f08" ON "recurring_invoice_runs" ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5888e17006270b09b0b7e6d6b7" ON "recurring_invoice_runs" ("recurringInvoiceId", "scheduledFor") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5888e17006270b09b0b7e6d6b7"`);
        await queryRunner.query(`DROP INDEX "IDX_4603b70f611605f6255c1e8f08"`);
        await queryRunner.query(`DROP INDEX "IDX_64d6098cc80f05d629ea086666"`);
        await queryRunner.query(`DROP TABLE "recurring_invoice_runs"`);
    }

}
