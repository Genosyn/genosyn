import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoCeiling1793890925972 implements MigrationInterface {
    name = 'TodoCeiling1793890925972'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "todos" ADD "ceilingJson" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "ceilingJson"`);
    }

}
