import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryWorkspaces1787087682351 implements MigrationInterface {
    name = 'RepositoryWorkspaces1787087682351'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_c26165830e566d19374b33c916"`);
        await queryRunner.query(`DROP INDEX "IDX_375473a9b0e4701a0a3cf3506e"`);
        await queryRunner.query(`DROP INDEX "IDX_36aeeb6816fc49cf682c343742"`);
        await queryRunner.query(`CREATE TABLE "temporary_employee_code_repository_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "repositoryId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('write'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "temporary_employee_code_repository_grants"("id", "employeeId", "repositoryId", "accessLevel", "createdAt") SELECT "id", "employeeId", "codeRepositoryId", "accessLevel", "createdAt" FROM "employee_code_repository_grants"`);
        await queryRunner.query(`DROP TABLE "employee_code_repository_grants"`);
        await queryRunner.query(`ALTER TABLE "temporary_employee_code_repository_grants" RENAME TO "employee_code_repository_grants"`);
        await queryRunner.query(`CREATE INDEX "IDX_36aeeb6816fc49cf682c343742" ON "employee_code_repository_grants" ("employeeId") `);
        await queryRunner.query(`CREATE TABLE "repository_work_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "repositoryId" varchar NOT NULL, "employeeId" varchar NOT NULL, "requestedByUserId" varchar, "instruction" text NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "branch" varchar, "baseCommit" varchar, "headCommit" varchar, "reply" text NOT NULL DEFAULT (''), "error" text NOT NULL DEFAULT (''), "filesChanged" integer NOT NULL DEFAULT (0), "insertions" integer NOT NULL DEFAULT (0), "deletions" integer NOT NULL DEFAULT (0), "publishedBranch" varchar, "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_bf872b12f062fea1eb572ff9bc" ON "repository_work_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_168342867c0cb432a44cedd67a" ON "repository_work_sessions" ("repositoryId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_44bb172e5a1c1890408ab5d78a" ON "repository_work_sessions" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_cc2fdb26c088604ffd160ffeed"`);
        await queryRunner.query(`CREATE TABLE "temporary_code_repositories" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "gitUrl" varchar NOT NULL, "defaultBranch" varchar NOT NULL DEFAULT ('main'), "authMode" varchar NOT NULL DEFAULT ('none'), "httpsUsername" varchar, "encryptedToken" text, "encryptedSshKey" text, "committerName" varchar, "committerEmail" varchar, "lastSyncedAt" datetime, "lastSyncStatus" varchar NOT NULL DEFAULT ('unknown'), "lastSyncError" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "origin" varchar NOT NULL DEFAULT ('remote'), "kind" varchar NOT NULL DEFAULT ('code'))`);
        await queryRunner.query(`INSERT INTO "temporary_code_repositories"("id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt" FROM "code_repositories"`);
        await queryRunner.query(`DROP TABLE "code_repositories"`);
        await queryRunner.query(`ALTER TABLE "temporary_code_repositories" RENAME TO "code_repositories"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cc2fdb26c088604ffd160ffeed" ON "code_repositories" ("companyId", "slug") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b95775912c066011236b6a180a" ON "employee_code_repository_grants" ("employeeId", "repositoryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc5eb3b0957512cc5afe107361" ON "employee_code_repository_grants" ("repositoryId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_fc5eb3b0957512cc5afe107361"`);
        await queryRunner.query(`DROP INDEX "IDX_b95775912c066011236b6a180a"`);
        await queryRunner.query(`DROP INDEX "IDX_cc2fdb26c088604ffd160ffeed"`);
        await queryRunner.query(`ALTER TABLE "code_repositories" RENAME TO "temporary_code_repositories"`);
        await queryRunner.query(`CREATE TABLE "code_repositories" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "gitUrl" varchar NOT NULL, "defaultBranch" varchar NOT NULL DEFAULT ('main'), "authMode" varchar NOT NULL DEFAULT ('none'), "httpsUsername" varchar, "encryptedToken" text, "encryptedSshKey" text, "committerName" varchar, "committerEmail" varchar, "lastSyncedAt" datetime, "lastSyncStatus" varchar NOT NULL DEFAULT ('unknown'), "lastSyncError" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "code_repositories"("id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt" FROM "temporary_code_repositories"`);
        await queryRunner.query(`DROP TABLE "temporary_code_repositories"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cc2fdb26c088604ffd160ffeed" ON "code_repositories" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_44bb172e5a1c1890408ab5d78a"`);
        await queryRunner.query(`DROP INDEX "IDX_168342867c0cb432a44cedd67a"`);
        await queryRunner.query(`DROP INDEX "IDX_bf872b12f062fea1eb572ff9bc"`);
        await queryRunner.query(`DROP TABLE "repository_work_sessions"`);
        await queryRunner.query(`DROP INDEX "IDX_36aeeb6816fc49cf682c343742"`);
        await queryRunner.query(`ALTER TABLE "employee_code_repository_grants" RENAME TO "temporary_employee_code_repository_grants"`);
        await queryRunner.query(`CREATE TABLE "employee_code_repository_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "codeRepositoryId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('write'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "employee_code_repository_grants"("id", "employeeId", "codeRepositoryId", "accessLevel", "createdAt") SELECT "id", "employeeId", "repositoryId", "accessLevel", "createdAt" FROM "temporary_employee_code_repository_grants"`);
        await queryRunner.query(`DROP TABLE "temporary_employee_code_repository_grants"`);
        await queryRunner.query(`CREATE INDEX "IDX_36aeeb6816fc49cf682c343742" ON "employee_code_repository_grants" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_375473a9b0e4701a0a3cf3506e" ON "employee_code_repository_grants" ("employeeId", "codeRepositoryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c26165830e566d19374b33c916" ON "employee_code_repository_grants" ("codeRepositoryId") `);
    }

}
