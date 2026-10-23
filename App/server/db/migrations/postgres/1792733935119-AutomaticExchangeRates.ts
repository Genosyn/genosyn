import { MigrationInterface, QueryRunner } from "typeorm";

export class AutomaticExchangeRates1792733935119 implements MigrationInterface {
    name = 'AutomaticExchangeRates1792733935119'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" ADD "exchangeRate" real`);
        await queryRunner.query(`ALTER TABLE "invoice_payments" ADD "exchangeRate" real`);
        await queryRunner.query(`ALTER TABLE "exchange_rates" ADD "automatic" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "company_finance_settings" ADD "automaticExchangeRates" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "bills" ADD "exchangeRate" real`);
        await queryRunner.query(`ALTER TABLE "bill_payments" ADD "exchangeRate" real`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bill_payments" DROP COLUMN "exchangeRate"`);
        await queryRunner.query(`ALTER TABLE "bills" DROP COLUMN "exchangeRate"`);
        await queryRunner.query(`ALTER TABLE "company_finance_settings" DROP COLUMN "automaticExchangeRates"`);
        await queryRunner.query(`ALTER TABLE "exchange_rates" DROP COLUMN "automatic"`);
        await queryRunner.query(`ALTER TABLE "invoice_payments" DROP COLUMN "exchangeRate"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "exchangeRate"`);
    }

}
