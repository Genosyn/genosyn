import { MigrationInterface, QueryRunner } from "typeorm";

export class DocumentDiscounts1792385893633 implements MigrationInterface {
    name = 'DocumentDiscounts1792385893633'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "invoices" ADD "discountPercent" real NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD "discountAmountCents" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD "discountCents" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "estimates" ADD "discountPercent" real NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "estimates" ADD "discountAmountCents" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "estimates" ADD "discountCents" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "estimates" DROP COLUMN "discountCents"`);
        await queryRunner.query(`ALTER TABLE "estimates" DROP COLUMN "discountAmountCents"`);
        await queryRunner.query(`ALTER TABLE "estimates" DROP COLUMN "discountPercent"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "discountCents"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "discountAmountCents"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "discountPercent"`);
    }

}
