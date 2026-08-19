import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryGithubConnection1787124314654 implements MigrationInterface {
    name = 'RepositoryGithubConnection1787124314654'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "code_repositories" ADD "githubConnectionId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "code_repositories" DROP COLUMN "githubConnectionId"`);
    }

}
