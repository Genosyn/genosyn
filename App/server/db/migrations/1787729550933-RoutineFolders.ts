import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineFolders1787729550933 implements MigrationInterface {
    name = 'RoutineFolders1787729550933'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_folders" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "parentId" varchar, "sortOrder" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_4421f6ac97607f90afc6473f51" ON "routine_folders" ("companyId", "parentId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_db59aa7dfe2b3527fb8220437b" ON "routine_folders" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_d1df6153bea86d36894c20710b" ON "routine_folders" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar)`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_d1df6153bea86d36894c20710b"`);
        await queryRunner.query(`DROP INDEX "IDX_db59aa7dfe2b3527fb8220437b"`);
        await queryRunner.query(`DROP INDEX "IDX_4421f6ac97607f90afc6473f51"`);
        await queryRunner.query(`DROP TABLE "routine_folders"`);
    }

}
