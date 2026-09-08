import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyProactiveDefaults1788870145153 implements MigrationInterface {
    name = 'CompanyProactiveDefaults1788870145153'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" ADD "proactiveAutoSetup" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "companies" ADD "proactiveDefaultsJson" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "proactiveDefaultsJson"`);
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "proactiveAutoSetup"`);
    }

}
