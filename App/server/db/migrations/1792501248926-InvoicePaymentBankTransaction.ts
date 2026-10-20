import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoicePaymentBankTransaction1792501248926 implements MigrationInterface {
    name = 'InvoicePaymentBankTransaction1792501248926'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3b2a25d4269ebe9d7ca0c1001d"`);
        await queryRunner.query(`CREATE TABLE "temporary_invoice_payments" ("id" varchar PRIMARY KEY NOT NULL, "invoiceId" varchar NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "paidAt" datetime NOT NULL, "method" varchar NOT NULL DEFAULT ('other'), "reference" varchar NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "bankTransactionId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_invoice_payments"("id", "invoiceId", "amountCents", "currency", "paidAt", "method", "reference", "notes", "createdById", "createdAt") SELECT "id", "invoiceId", "amountCents", "currency", "paidAt", "method", "reference", "notes", "createdById", "createdAt" FROM "invoice_payments"`);
        await queryRunner.query(`DROP TABLE "invoice_payments"`);
        await queryRunner.query(`ALTER TABLE "temporary_invoice_payments" RENAME TO "invoice_payments"`);
        await queryRunner.query(`CREATE INDEX "IDX_3b2a25d4269ebe9d7ca0c1001d" ON "invoice_payments" ("invoiceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c6ee814b32732f6ad7244cd8d1" ON "invoice_payments" ("bankTransactionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_c6ee814b32732f6ad7244cd8d1"`);
        await queryRunner.query(`DROP INDEX "IDX_3b2a25d4269ebe9d7ca0c1001d"`);
        await queryRunner.query(`ALTER TABLE "invoice_payments" RENAME TO "temporary_invoice_payments"`);
        await queryRunner.query(`CREATE TABLE "invoice_payments" ("id" varchar PRIMARY KEY NOT NULL, "invoiceId" varchar NOT NULL, "amountCents" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "paidAt" datetime NOT NULL, "method" varchar NOT NULL DEFAULT ('other'), "reference" varchar NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "invoice_payments"("id", "invoiceId", "amountCents", "currency", "paidAt", "method", "reference", "notes", "createdById", "createdAt") SELECT "id", "invoiceId", "amountCents", "currency", "paidAt", "method", "reference", "notes", "createdById", "createdAt" FROM "temporary_invoice_payments"`);
        await queryRunner.query(`DROP TABLE "temporary_invoice_payments"`);
        await queryRunner.query(`CREATE INDEX "IDX_3b2a25d4269ebe9d7ca0c1001d" ON "invoice_payments" ("invoiceId") `);
    }

}
