import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkspaces1787087724088 implements MigrationInterface {
    name = 'RepositoryWorkspaces1787087724088'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_375473a9b0e4701a0a3cf3506e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c26165830e566d19374b33c916"`);
        await queryRunner.query(`ALTER TABLE "employee_code_repository_grants" RENAME COLUMN "codeRepositoryId" TO "repositoryId"`);
        await queryRunner.query(`CREATE TABLE "repository_work_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "repositoryId" character varying NOT NULL, "employeeId" character varying NOT NULL, "requestedByUserId" character varying, "instruction" text NOT NULL, "status" character varying NOT NULL DEFAULT 'running', "branch" character varying, "baseCommit" character varying, "headCommit" character varying, "reply" text NOT NULL DEFAULT '', "error" text NOT NULL DEFAULT '', "filesChanged" integer NOT NULL DEFAULT '0', "insertions" integer NOT NULL DEFAULT '0', "deletions" integer NOT NULL DEFAULT '0', "publishedBranch" character varying, "finishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c38d86c1e6778e8f3bee2bd768f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bf872b12f062fea1eb572ff9bc" ON "repository_work_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_168342867c0cb432a44cedd67a" ON "repository_work_sessions" ("repositoryId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_44bb172e5a1c1890408ab5d78a" ON "repository_work_sessions" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "code_repositories" ADD "origin" character varying NOT NULL DEFAULT 'remote'`);
        await queryRunner.query(`ALTER TABLE "code_repositories" ADD "kind" character varying NOT NULL DEFAULT 'code'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b95775912c066011236b6a180a" ON "employee_code_repository_grants" ("employeeId", "repositoryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc5eb3b0957512cc5afe107361" ON "employee_code_repository_grants" ("repositoryId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_fc5eb3b0957512cc5afe107361"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b95775912c066011236b6a180a"`);
        await queryRunner.query(`ALTER TABLE "code_repositories" DROP COLUMN "kind"`);
        await queryRunner.query(`ALTER TABLE "code_repositories" DROP COLUMN "origin"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_44bb172e5a1c1890408ab5d78a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_168342867c0cb432a44cedd67a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bf872b12f062fea1eb572ff9bc"`);
        await queryRunner.query(`DROP TABLE "repository_work_sessions"`);
        await queryRunner.query(`ALTER TABLE "employee_code_repository_grants" RENAME COLUMN "repositoryId" TO "codeRepositoryId"`);
        await queryRunner.query(`CREATE INDEX "IDX_c26165830e566d19374b33c916" ON "employee_code_repository_grants" ("codeRepositoryId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_375473a9b0e4701a0a3cf3506e" ON "employee_code_repository_grants" ("employeeId", "codeRepositoryId") `);
    }

}
