import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryCommandPermissions1787680091240 implements MigrationInterface {
    name = 'RepositoryCommandPermissions1787680091240'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "code_repositories" ADD "commandMode" character varying NOT NULL DEFAULT 'allowlist'`);
        await queryRunner.query(`ALTER TABLE "code_repositories" ADD "allowedCommands" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "code_repositories" DROP COLUMN "allowedCommands"`);
        await queryRunner.query(`ALTER TABLE "code_repositories" DROP COLUMN "commandMode"`);
    }

}
