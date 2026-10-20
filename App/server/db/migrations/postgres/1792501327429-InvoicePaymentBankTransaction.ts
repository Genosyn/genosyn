import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoicePaymentBankTransaction1792501327429 implements MigrationInterface {
    name = 'InvoicePaymentBankTransaction1792501327429'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoice_payments" ADD "bankTransactionId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_c6ee814b32732f6ad7244cd8d1" ON "invoice_payments" ("bankTransactionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c6ee814b32732f6ad7244cd8d1"`);
        await queryRunner.query(`ALTER TABLE "invoice_payments" DROP COLUMN "bankTransactionId"`);
    }

}
