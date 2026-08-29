import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanySsoAllowedDomains1787997836408 implements MigrationInterface {
    name = 'CompanySsoAllowedDomains1787997836408'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "company_sso" ADD "allowedEmailDomains" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "company_sso" DROP COLUMN "allowedEmailDomains"`);
    }

}
