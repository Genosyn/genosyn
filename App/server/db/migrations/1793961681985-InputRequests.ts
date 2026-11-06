import { MigrationInterface, QueryRunner } from "typeorm";

export class InputRequests1793961681985 implements MigrationInterface {
    name = 'InputRequests1793961681985'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "input_requests" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "kind" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('waiting'), "workKey" varchar NOT NULL, "runId" varchar, "routineId" varchar, "todoId" varchar, "conversationId" varchar, "browserSessionId" varchar, "vaultItemId" varchar, "assigneeUserId" varchar, "adminOnly" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "pageOrigin" varchar NOT NULL DEFAULT (''), "askingUntil" datetime, "readyAt" datetime, "readyByUserId" varchar, "answeredAt" datetime, "answeredByUserId" varchar, "attempts" integer NOT NULL DEFAULT (0), "codesGiven" integer NOT NULL DEFAULT (0), "lastCodeRefused" boolean NOT NULL DEFAULT (0), "reminders" integer NOT NULL DEFAULT (0), "nextReminderAt" datetime, "expiresAt" datetime NOT NULL, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "title" varchar NOT NULL DEFAULT (''), "body" text NOT NULL DEFAULT (''), "answerText" text, "encryptedAnswer" text, "closeReason" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_2c6664b82fca57fafd9cd3a1d9" ON "input_requests" ("workKey", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_c430cf76c2682858c9034b5c52" ON "input_requests" ("status", "nextReminderAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab73604bdd1e84d3347e6709f4" ON "input_requests" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e4f69c7177b3097ce49b81a67" ON "input_requests" ("companyId", "status") `);
        await queryRunner.query(`DROP INDEX "IDX_aaaea7e6127a655d678f23b60f"`);
        await queryRunner.query(`DROP INDEX "IDX_291c1c0c98b298f8ea7fb7426b"`);
        await queryRunner.query(`DROP INDEX "IDX_62e3c170e93f23c5be78832c47"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text, "diagnosticsJson" text, "requiredToolsJson" text, "employeeId" varchar, "queueActiveEmployeeId" varchar, "queueOptionsJson" text, "pausedAt" datetime, "pauseCount" integer NOT NULL DEFAULT (0), "pauseRemainingMs" integer, "pauseReason" varchar, "outagePauses" integer NOT NULL DEFAULT (0), "personPauses" integer NOT NULL DEFAULT (0), "waitingOnInputRequestId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs", "pauseReason", "outagePauses") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs", "pauseReason", "outagePauses" FROM "runs"`);
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_aaaea7e6127a655d678f23b60f" ON "runs" ("parentRunId") `);
        await queryRunner.query(`CREATE INDEX "IDX_291c1c0c98b298f8ea7fb7426b" ON "runs" ("employeeId", "status", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_62e3c170e93f23c5be78832c47" ON "runs" ("queueActiveEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_62e3c170e93f23c5be78832c47"`);
        await queryRunner.query(`DROP INDEX "IDX_291c1c0c98b298f8ea7fb7426b"`);
        await queryRunner.query(`DROP INDEX "IDX_aaaea7e6127a655d678f23b60f"`);
        await queryRunner.query(`ALTER TABLE "runs" RENAME TO "temporary_runs"`);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text, "diagnosticsJson" text, "requiredToolsJson" text, "employeeId" varchar, "queueActiveEmployeeId" varchar, "queueOptionsJson" text, "pausedAt" datetime, "pauseCount" integer NOT NULL DEFAULT (0), "pauseRemainingMs" integer, "pauseReason" varchar, "outagePauses" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs", "pauseReason", "outagePauses") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason", "checkpointJson", "continuationCount", "continuationOriginTriggerKind", "continuationReviewOnly", "continuationDeadlineAt", "continuationTokensUsed", "continuationStopReason", "diagnosticsJson", "requiredToolsJson", "employeeId", "queueActiveEmployeeId", "queueOptionsJson", "pausedAt", "pauseCount", "pauseRemainingMs", "pauseReason", "outagePauses" FROM "temporary_runs"`);
        await queryRunner.query(`DROP TABLE "temporary_runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_62e3c170e93f23c5be78832c47" ON "runs" ("queueActiveEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_291c1c0c98b298f8ea7fb7426b" ON "runs" ("employeeId", "status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_aaaea7e6127a655d678f23b60f" ON "runs" ("parentRunId") `);
        await queryRunner.query(`DROP INDEX "IDX_8e4f69c7177b3097ce49b81a67"`);
        await queryRunner.query(`DROP INDEX "IDX_ab73604bdd1e84d3347e6709f4"`);
        await queryRunner.query(`DROP INDEX "IDX_c430cf76c2682858c9034b5c52"`);
        await queryRunner.query(`DROP INDEX "IDX_2c6664b82fca57fafd9cd3a1d9"`);
        await queryRunner.query(`DROP TABLE "input_requests"`);
    }

}
