import { MigrationInterface, QueryRunner } from "typeorm";

export class EvidenceAndTheStop1788091477702 implements MigrationInterface {
    name = 'EvidenceAndTheStop1788091477702'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_checks" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "routineId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('effect'), "spec" text NOT NULL DEFAULT (''), "required" boolean NOT NULL DEFAULT (1), "enabled" boolean NOT NULL DEFAULT (1), "timeoutSec" integer NOT NULL DEFAULT (120), "position" integer NOT NULL DEFAULT (0), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_cf6c878157e725522dcc98950b" ON "routine_checks" ("routineId", "position") `);
        await queryRunner.query(`CREATE TABLE "run_check_results" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "runId" varchar NOT NULL, "checkId" varchar, "name" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('effect'), "required" boolean NOT NULL DEFAULT (1), "passed" boolean NOT NULL DEFAULT (0), "exitCode" integer, "detail" text NOT NULL DEFAULT (''), "durationMs" integer NOT NULL DEFAULT (0), "attempt" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2613af567a892d15fe9e3a9173" ON "run_check_results" ("runId", "attempt") `);
        await queryRunner.query(`CREATE TABLE "standdowns" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "scope" varchar NOT NULL DEFAULT ('company'), "scopeId" varchar, "reason" text NOT NULL DEFAULT (''), "source" varchar NOT NULL DEFAULT ('human'), "placedByUserId" varchar, "placedAt" datetime NOT NULL, "liftedAt" datetime, "liftedByUserId" varchar, "liftedReason" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_77b0941634c75b64d5ee5cdc24" ON "standdowns" ("companyId", "liftedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar, "consecutiveFailures" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut" FROM "runs"`);
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_2323dcc5e0a78dbce80fc46a88"`);
        await queryRunner.query(`CREATE TABLE "temporary_audit_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "actorKind" varchar NOT NULL DEFAULT ('user'), "actorUserId" varchar, "action" varchar NOT NULL, "targetType" varchar NOT NULL DEFAULT (''), "targetId" varchar, "targetLabel" varchar NOT NULL DEFAULT (''), "metadataJson" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actorEmployeeId" varchar, "runId" varchar, "conversationId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_audit_events"("id", "companyId", "actorKind", "actorUserId", "action", "targetType", "targetId", "targetLabel", "metadataJson", "createdAt", "actorEmployeeId") SELECT "id", "companyId", "actorKind", "actorUserId", "action", "targetType", "targetId", "targetLabel", "metadataJson", "createdAt", "actorEmployeeId" FROM "audit_events"`);
        await queryRunner.query(`DROP TABLE "audit_events"`);
        await queryRunner.query(`ALTER TABLE "temporary_audit_events" RENAME TO "audit_events"`);
        await queryRunner.query(`CREATE INDEX "IDX_2323dcc5e0a78dbce80fc46a88" ON "audit_events" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_dade7093e74d6b81a4502e1529" ON "audit_events" ("companyId", "actorEmployeeId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5bc0eca9bf57d34cedb219ac6a" ON "audit_events" ("runId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5bc0eca9bf57d34cedb219ac6a"`);
        await queryRunner.query(`DROP INDEX "IDX_dade7093e74d6b81a4502e1529"`);
        await queryRunner.query(`DROP INDEX "IDX_2323dcc5e0a78dbce80fc46a88"`);
        await queryRunner.query(`ALTER TABLE "audit_events" RENAME TO "temporary_audit_events"`);
        await queryRunner.query(`CREATE TABLE "audit_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "actorKind" varchar NOT NULL DEFAULT ('user'), "actorUserId" varchar, "action" varchar NOT NULL, "targetType" varchar NOT NULL DEFAULT (''), "targetId" varchar, "targetLabel" varchar NOT NULL DEFAULT (''), "metadataJson" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actorEmployeeId" varchar)`);
        await queryRunner.query(`INSERT INTO "audit_events"("id", "companyId", "actorKind", "actorUserId", "action", "targetType", "targetId", "targetLabel", "metadataJson", "createdAt", "actorEmployeeId") SELECT "id", "companyId", "actorKind", "actorUserId", "action", "targetType", "targetId", "targetLabel", "metadataJson", "createdAt", "actorEmployeeId" FROM "temporary_audit_events"`);
        await queryRunner.query(`DROP TABLE "temporary_audit_events"`);
        await queryRunner.query(`CREATE INDEX "IDX_2323dcc5e0a78dbce80fc46a88" ON "audit_events" ("companyId", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`ALTER TABLE "runs" RENAME TO "temporary_runs"`);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut" FROM "temporary_runs"`);
        await queryRunner.query(`DROP TABLE "temporary_runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar, "folderId" varchar, "acceptanceCriteria" text NOT NULL DEFAULT (''), "goalId" varchar)`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout", "memberBrowserId", "folderId", "acceptanceCriteria", "goalId" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`DROP INDEX "IDX_77b0941634c75b64d5ee5cdc24"`);
        await queryRunner.query(`DROP TABLE "standdowns"`);
        await queryRunner.query(`DROP INDEX "IDX_2613af567a892d15fe9e3a9173"`);
        await queryRunner.query(`DROP TABLE "run_check_results"`);
        await queryRunner.query(`DROP INDEX "IDX_cf6c878157e725522dcc98950b"`);
        await queryRunner.query(`DROP TABLE "routine_checks"`);
    }

}
