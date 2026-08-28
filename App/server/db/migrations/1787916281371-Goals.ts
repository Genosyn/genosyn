import { MigrationInterface, QueryRunner } from "typeorm";

export class Goals1787916281371 implements MigrationInterface {
    name = 'Goals1787916281371'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "goals" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "parentGoalId" varchar, "ownerEmployeeId" varchar, "metricKind" varchar NOT NULL DEFAULT ('manual'), "chartId" varchar, "startValue" real, "targetValue" real NOT NULL, "currentValue" real, "currentValueUpdatedAt" datetime, "direction" varchar NOT NULL DEFAULT ('increase_to'), "unit" varchar NOT NULL DEFAULT (''), "dueAt" datetime, "status" varchar NOT NULL DEFAULT ('active'), "settledAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_1087ee67d19c93aacd15308671" ON "goals" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_18be48306abc4a617bf9eac79a" ON "goals" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_18be48306abc4a617bf9eac79a"`);
        await queryRunner.query(`DROP INDEX "IDX_1087ee67d19c93aacd15308671"`);
        await queryRunner.query(`DROP TABLE "goals"`);
    }

}
