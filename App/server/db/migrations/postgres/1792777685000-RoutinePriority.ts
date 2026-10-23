import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutinePriority1792777685000 implements MigrationInterface {
    name = 'RoutinePriority1792777685000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ADD "priority" character varying NOT NULL DEFAULT 'normal'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "priority"`);
    }

}
