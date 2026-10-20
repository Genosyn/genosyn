import { MigrationInterface, QueryRunner } from "typeorm";

export class RecurringInvoiceLinks1792505850138 implements MigrationInterface {
    name = 'RecurringInvoiceLinks1792505850138'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" ADD "recurringInvoiceId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_4896213d201354fd588d2e1104" ON "invoices" ("companyId", "recurringInvoiceId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_4896213d201354fd588d2e1104"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "recurringInvoiceId"`);
    }

}
