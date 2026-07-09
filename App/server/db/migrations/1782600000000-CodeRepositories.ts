import { MigrationInterface, QueryRunner } from "typeorm";

export class CodeRepositories1782600000000 implements MigrationInterface {
    name = 'CodeRepositories1782600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "code_repositories" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "gitUrl" varchar NOT NULL, "defaultBranch" varchar NOT NULL DEFAULT ('main'), "authMode" varchar NOT NULL DEFAULT ('none'), "httpsUsername" varchar, "encryptedToken" text, "encryptedSshKey" text, "committerName" varchar, "committerEmail" varchar, "lastSyncedAt" datetime, "lastSyncStatus" varchar NOT NULL DEFAULT ('unknown'), "lastSyncError" text NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_cc2fdb26c088604ffd160ffeed" ON "code_repositories" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "employee_code_repository_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "codeRepositoryId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('write'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_375473a9b0e4701a0a3cf3506e" ON "employee_code_repository_grants" ("employeeId", "codeRepositoryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c26165830e566d19374b33c916" ON "employee_code_repository_grants" ("codeRepositoryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_36aeeb6816fc49cf682c343742" ON "employee_code_repository_grants" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_36aeeb6816fc49cf682c343742"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_c26165830e566d19374b33c916"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_375473a9b0e4701a0a3cf3506e"`);
        await queryRunner.query(`DROP TABLE "employee_code_repository_grants"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cc2fdb26c088604ffd160ffeed"`);
        await queryRunner.query(`DROP TABLE "code_repositories"`);
    }

}
