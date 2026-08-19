import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkSessionTurns1787162416470 implements MigrationInterface {
    name = 'RepositoryWorkSessionTurns1787162416470'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "repository_work_session_turns" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "sessionId" varchar NOT NULL, "ordinal" integer NOT NULL DEFAULT (1), "instruction" text NOT NULL, "reply" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('running'), "error" text NOT NULL DEFAULT (''), "requestedByUserId" varchar, "baseCommit" varchar, "headCommit" varchar, "filesChanged" integer NOT NULL DEFAULT (0), "insertions" integer NOT NULL DEFAULT (0), "deletions" integer NOT NULL DEFAULT (0), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_e7d09806c127fffa7eefdf33bc" ON "repository_work_session_turns" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_72118bf4c4c7b4965ffe014004" ON "repository_work_session_turns" ("sessionId", "ordinal") `);
        await queryRunner.query(`DROP INDEX "IDX_44bb172e5a1c1890408ab5d78a"`);
        await queryRunner.query(`DROP INDEX "IDX_168342867c0cb432a44cedd67a"`);
        await queryRunner.query(`DROP INDEX "IDX_bf872b12f062fea1eb572ff9bc"`);
        await queryRunner.query(`CREATE TABLE "temporary_repository_work_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "repositoryId" varchar NOT NULL, "employeeId" varchar NOT NULL, "requestedByUserId" varchar, "instruction" text NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "branch" varchar, "baseCommit" varchar, "headCommit" varchar, "reply" text NOT NULL DEFAULT (''), "error" text NOT NULL DEFAULT (''), "filesChanged" integer NOT NULL DEFAULT (0), "insertions" integer NOT NULL DEFAULT (0), "deletions" integer NOT NULL DEFAULT (0), "publishedBranch" varchar, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "title" varchar NOT NULL DEFAULT (''), "turnCount" integer NOT NULL DEFAULT (0), "pullRequestUrl" varchar, "pullRequestNumber" integer)`);
        await queryRunner.query(`INSERT INTO "temporary_repository_work_sessions"("id", "companyId", "repositoryId", "employeeId", "requestedByUserId", "instruction", "status", "branch", "baseCommit", "headCommit", "reply", "error", "filesChanged", "insertions", "deletions", "publishedBranch", "finishedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "repositoryId", "employeeId", "requestedByUserId", "instruction", "status", "branch", "baseCommit", "headCommit", "reply", "error", "filesChanged", "insertions", "deletions", "publishedBranch", "finishedAt", "createdAt", "updatedAt" FROM "repository_work_sessions"`);
        await queryRunner.query(`DROP TABLE "repository_work_sessions"`);
        await queryRunner.query(`ALTER TABLE "temporary_repository_work_sessions" RENAME TO "repository_work_sessions"`);
        await queryRunner.query(`CREATE INDEX "IDX_44bb172e5a1c1890408ab5d78a" ON "repository_work_sessions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_168342867c0cb432a44cedd67a" ON "repository_work_sessions" ("repositoryId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bf872b12f062fea1eb572ff9bc" ON "repository_work_sessions" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_bf872b12f062fea1eb572ff9bc"`);
        await queryRunner.query(`DROP INDEX "IDX_168342867c0cb432a44cedd67a"`);
        await queryRunner.query(`DROP INDEX "IDX_44bb172e5a1c1890408ab5d78a"`);
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" RENAME TO "temporary_repository_work_sessions"`);
        await queryRunner.query(`CREATE TABLE "repository_work_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "repositoryId" varchar NOT NULL, "employeeId" varchar NOT NULL, "requestedByUserId" varchar, "instruction" text NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "branch" varchar, "baseCommit" varchar, "headCommit" varchar, "reply" text NOT NULL DEFAULT (''), "error" text NOT NULL DEFAULT (''), "filesChanged" integer NOT NULL DEFAULT (0), "insertions" integer NOT NULL DEFAULT (0), "deletions" integer NOT NULL DEFAULT (0), "publishedBranch" varchar, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "repository_work_sessions"("id", "companyId", "repositoryId", "employeeId", "requestedByUserId", "instruction", "status", "branch", "baseCommit", "headCommit", "reply", "error", "filesChanged", "insertions", "deletions", "publishedBranch", "finishedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "repositoryId", "employeeId", "requestedByUserId", "instruction", "status", "branch", "baseCommit", "headCommit", "reply", "error", "filesChanged", "insertions", "deletions", "publishedBranch", "finishedAt", "createdAt", "updatedAt" FROM "temporary_repository_work_sessions"`);
        await queryRunner.query(`DROP TABLE "temporary_repository_work_sessions"`);
        await queryRunner.query(`CREATE INDEX "IDX_bf872b12f062fea1eb572ff9bc" ON "repository_work_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_168342867c0cb432a44cedd67a" ON "repository_work_sessions" ("repositoryId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_44bb172e5a1c1890408ab5d78a" ON "repository_work_sessions" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_72118bf4c4c7b4965ffe014004"`);
        await queryRunner.query(`DROP INDEX "IDX_e7d09806c127fffa7eefdf33bc"`);
        await queryRunner.query(`DROP TABLE "repository_work_session_turns"`);
    }

}
