import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionStackSettings1791530430122 implements MigrationInterface {
    name = 'DecisionStackSettings1791530430122'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" ADD "decisionStackEnabled" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "companies" ADD "decisionStackInstructions" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "decisionStackInstructions"`);
        await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "decisionStackEnabled"`);
    }

}
