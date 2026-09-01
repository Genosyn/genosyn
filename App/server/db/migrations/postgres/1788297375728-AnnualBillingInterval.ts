import { MigrationInterface, QueryRunner } from "typeorm";

export class AnnualBillingInterval1788297375728 implements MigrationInterface {
    name = 'AnnualBillingInterval1788297375728'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "company_billing" ADD "billingInterval" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "company_billing" DROP COLUMN "billingInterval"`);
    }

}
