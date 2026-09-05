import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkSessionEvents1788558202313 implements MigrationInterface {
    name = 'RepositoryWorkSessionEvents1788558202313'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "repository_work_session_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "repositoryId" character varying NOT NULL, "sessionId" character varying NOT NULL, "turnId" character varying NOT NULL, "ordinal" integer NOT NULL, "kind" character varying NOT NULL, "name" character varying NOT NULL DEFAULT '', "callId" character varying NOT NULL DEFAULT '', "summary" text NOT NULL DEFAULT '', "detailJson" text NOT NULL DEFAULT '', "isError" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_210fe73b612cfb9d4b7a38c5ac9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a147e82a890588dfe0fca42ddb" ON "repository_work_session_events" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_af34b6cd79cf90dafa462b918c" ON "repository_work_session_events" ("turnId") `);
        await queryRunner.query(`CREATE INDEX "IDX_48f12af3abef8cc236151566c8" ON "repository_work_session_events" ("sessionId", "ordinal") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_48f12af3abef8cc236151566c8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_af34b6cd79cf90dafa462b918c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a147e82a890588dfe0fca42ddb"`);
        await queryRunner.query(`DROP TABLE "repository_work_session_events"`);
    }

}
