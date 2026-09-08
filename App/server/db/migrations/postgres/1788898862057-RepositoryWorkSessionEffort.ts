import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkSessionEffort1788898862057 implements MigrationInterface {
    name = 'RepositoryWorkSessionEffort1788898862057'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "effort" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "effort"`);
    }

}
