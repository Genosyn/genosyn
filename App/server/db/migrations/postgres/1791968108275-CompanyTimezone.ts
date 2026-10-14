import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyTimezone1791968108275 implements MigrationInterface {
    name = 'CompanyTimezone1791968108275'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" ADD "timezone" character varying NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "timezone"`);
    }

}
