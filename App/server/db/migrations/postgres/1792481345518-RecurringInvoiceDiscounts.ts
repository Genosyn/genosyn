import { MigrationInterface, QueryRunner } from "typeorm";

export class RecurringInvoiceDiscounts1792481345518 implements MigrationInterface {
    name = 'RecurringInvoiceDiscounts1792481345518'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recurring_invoices" ADD "discountPercent" real NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" ADD "discountAmountCents" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "recurring_invoices" DROP COLUMN "discountAmountCents"`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" DROP COLUMN "discountPercent"`);
    }

}
