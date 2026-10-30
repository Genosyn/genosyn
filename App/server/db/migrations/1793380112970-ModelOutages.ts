import { MigrationInterface, QueryRunner } from "typeorm";

export class ModelOutages1793380112970 implements MigrationInterface {
    name = 'ModelOutages1793380112970'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_model_outages" ("id" varchar PRIMARY KEY NOT NULL, "key" varchar NOT NULL, "companyId" varchar NOT NULL, "modelId" varchar NOT NULL, "startedAt" datetime NOT NULL, "endedAt" datetime, "recoveredBy" varchar, "cause" varchar NOT NULL, "lastError" varchar(300) NOT NULL, "lastStatus" integer, "checks" integer NOT NULL DEFAULT (0), "lastCheckedAt" datetime, "nextCheckAt" datetime NOT NULL, "notifiedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_01af90b43afc9262c3dce4841e" ON "ai_model_outages" ("companyId", "startedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b192b332a5c87dfb1a708d09e0" ON "ai_model_outages" ("key") WHERE "endedAt" IS NULL`);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_62e3c170e93f23c5be78832c47"`);
        await queryRunner.query(`DROP INDEX "IDX_291c1c0c98b298f8ea7fb7426b"`);
        await queryRunner.query(`DROP INDEX "IDX_aaaea7e6127a655d678f23b60f"`);
        await queryRunner.query(`CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text, "diagnosticsJson" text, "requiredToolsJson" text, "employeeId" varchar, "queueActiveEmployeeId" varchar, "queueOptionsJson" text, "pausedAt" datetime, "pauseCount" integer NOT NULL DEFAULT (0), "pauseRemainingMs" integer, "pauseReason" varchar, "outagePauses" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs" FROM "runs"`);
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_62e3c170e93f23c5be78832c47" ON "runs" ("queueActiveEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_291c1c0c98b298f8ea7fb7426b" ON "runs" ("employeeId", "status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_aaaea7e6127a655d678f23b60f" ON "runs" ("parentRunId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_aaaea7e6127a655d678f23b60f"`);
        await queryRunner.query(`DROP INDEX "IDX_291c1c0c98b298f8ea7fb7426b"`);
        await queryRunner.query(`DROP INDEX "IDX_62e3c170e93f23c5be78832c47"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`ALTER TABLE "runs" RENAME TO "temporary_runs"`);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text, "diagnosticsJson" text, "requiredToolsJson" text, "employeeId" varchar, "queueActiveEmployeeId" varchar, "queueOptionsJson" text, "pausedAt" datetime, "pauseCount" integer NOT NULL DEFAULT (0), "pauseRemainingMs" integer)`);
        await queryRunner.query(`INSERT INTO "runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs" FROM "temporary_runs"`);
        await queryRunner.query(`DROP TABLE "temporary_runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_aaaea7e6127a655d678f23b60f" ON "runs" ("parentRunId") `);
        await queryRunner.query(`CREATE INDEX "IDX_291c1c0c98b298f8ea7fb7426b" ON "runs" ("employeeId", "status", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_62e3c170e93f23c5be78832c47" ON "runs" ("queueActiveEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_b192b332a5c87dfb1a708d09e0"`);
        await queryRunner.query(`DROP INDEX "IDX_01af90b43afc9262c3dce4841e"`);
        await queryRunner.query(`DROP TABLE "ai_model_outages"`);
    }

}
