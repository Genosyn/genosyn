import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkSessionEvents1788558161747 implements MigrationInterface {
    name = 'RepositoryWorkSessionEvents1788558161747'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "repository_work_session_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "repositoryId" varchar NOT NULL, "sessionId" varchar NOT NULL, "turnId" varchar NOT NULL, "ordinal" integer NOT NULL, "kind" varchar NOT NULL, "name" varchar NOT NULL DEFAULT (''), "callId" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "detailJson" text NOT NULL DEFAULT (''), "isError" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a147e82a890588dfe0fca42ddb" ON "repository_work_session_events" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_af34b6cd79cf90dafa462b918c" ON "repository_work_session_events" ("turnId") `);
        await queryRunner.query(`CREATE INDEX "IDX_48f12af3abef8cc236151566c8" ON "repository_work_session_events" ("sessionId", "ordinal") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_48f12af3abef8cc236151566c8"`);
        await queryRunner.query(`DROP INDEX "IDX_af34b6cd79cf90dafa462b918c"`);
        await queryRunner.query(`DROP INDEX "IDX_a147e82a890588dfe0fca42ddb"`);
        await queryRunner.query(`DROP TABLE "repository_work_session_events"`);
    }

}
