import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionSummaries1791535865478 implements MigrationInterface {
    name = 'DecisionSummaries1791535865478'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" ADD "summary" character varying`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "recommendation" character varying`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "pickupReport" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "pickupReport"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "recommendation"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "summary"`);
    }

}
