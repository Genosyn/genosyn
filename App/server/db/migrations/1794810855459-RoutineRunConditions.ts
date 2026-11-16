import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineRunConditions1794810855459 implements MigrationInterface {
    name = 'RoutineRunConditions1794810855459'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (21600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar, "consecutiveFailures" integer NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "selfReviewOnly" boolean NOT NULL DEFAULT (0), "priority" varchar NOT NULL DEFAULT ('normal'), "runCondition" varchar NOT NULL DEFAULT ('always'), "nothingDueAt" datetime, "nothingDueCount" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures", "mailDeliveryMode", "selfReviewOnly", "priority") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures", "mailDeliveryMode", "selfReviewOnly", "priority" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`DROP INDEX "IDX_055cc5b6d1121a4b039d06b3ab"`);
        await queryRunner.query(`CREATE TABLE "temporary_workstreams" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "title" varchar NOT NULL, "objective" text NOT NULL DEFAULT (''), "stateDoc" text NOT NULL DEFAULT (''), "routineId" varchar, "status" varchar NOT NULL DEFAULT ('active'), "closeReason" text NOT NULL DEFAULT (''), "lastRunId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "revisitAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_workstreams"("id", "companyId", "employeeId", "title", "objective", "stateDoc", "routineId", "status", "closeReason", "lastRunId", "createdAt", "updatedAt") SELECT "id", "companyId", "employeeId", "title", "objective", "stateDoc", "routineId", "status", "closeReason", "lastRunId", "createdAt", "updatedAt" FROM "workstreams"`);
        await queryRunner.query(`DROP TABLE "workstreams"`);
        await queryRunner.query(`ALTER TABLE "temporary_workstreams" RENAME TO "workstreams"`);
        await queryRunner.query(`CREATE INDEX "IDX_055cc5b6d1121a4b039d06b3ab" ON "workstreams" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_a723deea0280ca1e92bb7f30df" ON "workstreams" ("employeeId", "status", "revisitAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a723deea0280ca1e92bb7f30df"`);
        await queryRunner.query(`DROP INDEX "IDX_055cc5b6d1121a4b039d06b3ab"`);
        await queryRunner.query(`ALTER TABLE "workstreams" RENAME TO "temporary_workstreams"`);
        await queryRunner.query(`CREATE TABLE "workstreams" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "title" varchar NOT NULL, "objective" text NOT NULL DEFAULT (''), "stateDoc" text NOT NULL DEFAULT (''), "routineId" varchar, "status" varchar NOT NULL DEFAULT ('active'), "closeReason" text NOT NULL DEFAULT (''), "lastRunId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "workstreams"("id", "companyId", "employeeId", "title", "objective", "stateDoc", "routineId", "status", "closeReason", "lastRunId", "createdAt", "updatedAt") SELECT "id", "companyId", "employeeId", "title", "objective", "stateDoc", "routineId", "status", "closeReason", "lastRunId", "createdAt", "updatedAt" FROM "temporary_workstreams"`);
        await queryRunner.query(`DROP TABLE "temporary_workstreams"`);
        await queryRunner.query(`CREATE INDEX "IDX_055cc5b6d1121a4b039d06b3ab" ON "workstreams" ("companyId", "status") `);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (21600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar, "consecutiveFailures" integer NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "selfReviewOnly" boolean NOT NULL DEFAULT (0), "priority" varchar NOT NULL DEFAULT ('normal'))`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures", "mailDeliveryMode", "selfReviewOnly", "priority") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId", "consecutiveFailures", "mailDeliveryMode", "selfReviewOnly", "priority" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
    }

}
