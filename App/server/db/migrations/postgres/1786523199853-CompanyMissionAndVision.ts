import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyMissionAndVision1786523199853 implements MigrationInterface {
    name = 'CompanyMissionAndVision1786523199853'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" ADD "mission" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "companies" ADD "vision" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "vision"`);
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "mission"`);
    }

}
