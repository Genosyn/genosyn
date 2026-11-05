import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoLimits1793897070383 implements MigrationInterface {
    name = 'TodoLimits1793897070383'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "todo_comments" ADD "fromLimitedTurn" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "todo_pickups" ADD "overLimits" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "todo_pickups" DROP COLUMN "overLimits"`);
        await queryRunner.query(`ALTER TABLE "todo_comments" DROP COLUMN "fromLimitedTurn"`);
    }

}
