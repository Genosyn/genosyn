import { MigrationInterface, QueryRunner } from "typeorm";

export class BrowserFollowups1781100000000 implements MigrationInterface {
    name = 'BrowserFollowups1781100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "temporary_companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "browserBackend" varchar NOT NULL DEFAULT ('local'), "browserbaseApiKeyEnc" text, "browserbaseProjectId" varchar, CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "temporary_companies"("id", "name", "slug", "ownerId", "createdAt") SELECT "id", "name", "slug", "ownerId", "createdAt" FROM "companies"`);
        await queryRunner.query(`DROP TABLE "companies"`);
        await queryRunner.query(`ALTER TABLE "temporary_companies" RENAME TO "companies"`);
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "soulBody" text NOT NULL DEFAULT (''), "avatarKey" varchar, "teamId" varchar, "reportsToEmployeeId" varchar, "reportsToUserId" varchar, "browserEnabled" boolean NOT NULL DEFAULT (0), "browserAllowedHosts" text, "browserApprovalRequired" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_ai_employees"("id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId", "browserEnabled") SELECT "id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId", "browserEnabled" FROM "ai_employees"`);
        await queryRunner.query(`DROP TABLE "ai_employees"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_employees" RENAME TO "ai_employees"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean)`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime)`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`ALTER TABLE "ai_employees" RENAME TO "temporary_ai_employees"`);
        await queryRunner.query(`CREATE TABLE "ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "soulBody" text NOT NULL DEFAULT (''), "avatarKey" varchar, "teamId" varchar, "reportsToEmployeeId" varchar, "reportsToUserId" varchar, "browserEnabled" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "ai_employees"("id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId", "browserEnabled") SELECT "id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId", "browserEnabled" FROM "temporary_ai_employees"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_employees"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
        await queryRunner.query(`ALTER TABLE "companies" RENAME TO "temporary_companies"`);
        await queryRunner.query(`CREATE TABLE "companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "companies"("id", "name", "slug", "ownerId", "createdAt") SELECT "id", "name", "slug", "ownerId", "createdAt" FROM "temporary_companies"`);
        await queryRunner.query(`DROP TABLE "temporary_companies"`);
    }

}
