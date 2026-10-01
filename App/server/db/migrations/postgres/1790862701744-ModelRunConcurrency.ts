import { MigrationInterface, QueryRunner } from "typeorm";

export class ModelRunConcurrency1790862701744 implements MigrationInterface {
    name = 'ModelRunConcurrency1790862701744'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "maxConcurrentRuns" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "maxConcurrentRuns"`);
    }

}
