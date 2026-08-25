import { MigrationInterface, QueryRunner } from "typeorm";

export class RepositoryCommandPermissions1787679588122 implements MigrationInterface {
    name = 'RepositoryCommandPermissions1787679588122'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_cc2fdb26c088604ffd160ffeed"`);
        await queryRunner.query(`CREATE TABLE "temporary_code_repositories" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "gitUrl" varchar NOT NULL, "defaultBranch" varchar NOT NULL DEFAULT ('main'), "authMode" varchar NOT NULL DEFAULT ('none'), "httpsUsername" varchar, "encryptedToken" text, "encryptedSshKey" text, "committerName" varchar, "committerEmail" varchar, "lastSyncedAt" datetime, "lastSyncStatus" varchar NOT NULL DEFAULT ('unknown'), "lastSyncError" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "origin" varchar NOT NULL DEFAULT ('remote'), "kind" varchar NOT NULL DEFAULT ('code'), "githubConnectionId" varchar, "commandMode" varchar NOT NULL DEFAULT ('allowlist'), "allowedCommands" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_code_repositories"("id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt", "origin", "kind", "githubConnectionId") SELECT "id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt", "origin", "kind", "githubConnectionId" FROM "code_repositories"`);
        await queryRunner.query(`DROP TABLE "code_repositories"`);
        await queryRunner.query(`ALTER TABLE "temporary_code_repositories" RENAME TO "code_repositories"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cc2fdb26c088604ffd160ffeed" ON "code_repositories" ("companyId", "slug") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_cc2fdb26c088604ffd160ffeed"`);
        await queryRunner.query(`ALTER TABLE "code_repositories" RENAME TO "temporary_code_repositories"`);
        await queryRunner.query(`CREATE TABLE "code_repositories" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "gitUrl" varchar NOT NULL, "defaultBranch" varchar NOT NULL DEFAULT ('main'), "authMode" varchar NOT NULL DEFAULT ('none'), "httpsUsername" varchar, "encryptedToken" text, "encryptedSshKey" text, "committerName" varchar, "committerEmail" varchar, "lastSyncedAt" datetime, "lastSyncStatus" varchar NOT NULL DEFAULT ('unknown'), "lastSyncError" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "origin" varchar NOT NULL DEFAULT ('remote'), "kind" varchar NOT NULL DEFAULT ('code'), "githubConnectionId" varchar)`);
        await queryRunner.query(`INSERT INTO "code_repositories"("id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt", "origin", "kind", "githubConnectionId") SELECT "id", "companyId", "name", "slug", "description", "gitUrl", "defaultBranch", "authMode", "httpsUsername", "encryptedToken", "encryptedSshKey", "committerName", "committerEmail", "lastSyncedAt", "lastSyncStatus", "lastSyncError", "createdById", "createdAt", "updatedAt", "origin", "kind", "githubConnectionId" FROM "temporary_code_repositories"`);
        await queryRunner.query(`DROP TABLE "temporary_code_repositories"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cc2fdb26c088604ffd160ffeed" ON "code_repositories" ("companyId", "slug") `);
    }

}
