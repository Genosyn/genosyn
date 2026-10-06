import { MigrationInterface, QueryRunner } from "typeorm";

export class RecurringInvoiceRuns1791206622085 implements MigrationInterface {
    name = 'RecurringInvoiceRuns1791206622085'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "recurring_invoice_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "recurringInvoiceId" character varying NOT NULL, "scheduledFor" TIMESTAMP WITH TIME ZONE NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "invoiceId" character varying, "attempts" integer NOT NULL DEFAULT '0', "emailAttempts" integer NOT NULL DEFAULT '0', "emailStatus" character varying NOT NULL DEFAULT '', "retryAt" TIMESTAMP WITH TIME ZONE, "lockedUntil" TIMESTAMP WITH TIME ZONE, "lastError" text NOT NULL DEFAULT '', "completedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c5a587efe39b5a7dc8182e6d95b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_64d6098cc80f05d629ea086666" ON "recurring_invoice_runs" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4603b70f611605f6255c1e8f08" ON "recurring_invoice_runs" ("status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5888e17006270b09b0b7e6d6b7" ON "recurring_invoice_runs" ("recurringInvoiceId", "scheduledFor") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5888e17006270b09b0b7e6d6b7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4603b70f611605f6255c1e8f08"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_64d6098cc80f05d629ea086666"`);
        await queryRunner.query(`DROP TABLE "recurring_invoice_runs"`);
    }

}
