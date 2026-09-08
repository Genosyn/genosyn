import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkSessionModel1788857194946 implements MigrationInterface {
    name = 'RepositoryWorkSessionModel1788857194946'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "modelId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "modelId"`);
    }

}
