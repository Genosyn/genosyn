import { MigrationInterface, QueryRunner } from "typeorm";

export class GoalValueSource1791919941570 implements MigrationInterface {
    name = 'GoalValueSource1791919941570'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "goals" ADD "currentValueSource" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "goals" DROP COLUMN "currentValueSource"`);
    }

}
