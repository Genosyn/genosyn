import { MigrationInterface, QueryRunner } from "typeorm";

export class WorkerRecoveryEvidence1789993619867 implements MigrationInterface {
    name = 'WorkerRecoveryEvidence1789993619867'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "parallel_worker_results" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "scopeKey" varchar NOT NULL, "authority" varchar NOT NULL, "requesterUserId" varchar NOT NULL DEFAULT (''), "parentRunId" varchar, "parentTurnId" varchar NOT NULL, "briefHash" varchar NOT NULL, "label" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "output" text NOT NULL DEFAULT (''), "totalChars" integer NOT NULL DEFAULT (0), "grantsJson" text NOT NULL, "requiredToolsJson" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7175f86e50b8dc2a8f93ae47fa" ON "parallel_worker_results" ("companyId", "employeeId", "scopeKey", "authority", "requesterUserId", "briefHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fae31c0ac461cbda133033210" ON "parallel_worker_results" ("companyId", "employeeId", "scopeKey", "authority", "requesterUserId") `);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text, "diagnosticsJson" text, "requiredToolsJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason" FROM "runs"`);
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`ALTER TABLE "runs" RENAME TO "temporary_runs"`);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text)`);
        await queryRunner.query(`INSERT INTO "runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason" FROM "temporary_runs"`);
        await queryRunner.query(`DROP TABLE "temporary_runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_0fae31c0ac461cbda133033210"`);
        await queryRunner.query(`DROP INDEX "IDX_7175f86e50b8dc2a8f93ae47fa"`);
        await queryRunner.query(`DROP TABLE "parallel_worker_results"`);
    }

}
