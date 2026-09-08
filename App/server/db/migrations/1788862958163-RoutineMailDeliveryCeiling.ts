import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineMailDeliveryCeiling1788862958163 implements MigrationInterface {
    name = 'RoutineMailDeliveryCeiling1788862958163'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar, "consecutiveFailures" integer NOT NULL DEFAULT (0), "mailDeliveryMode" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar, "consecutiveFailures" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
    }

}
