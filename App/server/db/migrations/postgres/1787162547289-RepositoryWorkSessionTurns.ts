import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkSessionTurns1787162547289 implements MigrationInterface {
    name = 'RepositoryWorkSessionTurns1787162547289'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "repository_work_session_turns" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "sessionId" character varying NOT NULL, "ordinal" integer NOT NULL DEFAULT '1', "instruction" text NOT NULL, "reply" text NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'running', "error" text NOT NULL DEFAULT '', "requestedByUserId" character varying, "baseCommit" character varying, "headCommit" character varying, "filesChanged" integer NOT NULL DEFAULT '0', "insertions" integer NOT NULL DEFAULT '0', "deletions" integer NOT NULL DEFAULT '0', "finishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1eb620d60952187d727e886f813" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e7d09806c127fffa7eefdf33bc" ON "repository_work_session_turns" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_72118bf4c4c7b4965ffe014004" ON "repository_work_session_turns" ("sessionId", "ordinal") `);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "title" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "turnCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "pullRequestUrl" character varying`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "pullRequestNumber" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "pullRequestNumber"`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "pullRequestUrl"`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "turnCount"`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "title"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_72118bf4c4c7b4965ffe014004"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e7d09806c127fffa7eefdf33bc"`);
        await queryRunner.query(`DROP TABLE "repository_work_session_turns"`);
    }

}
