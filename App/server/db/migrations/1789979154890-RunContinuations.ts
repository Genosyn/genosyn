import { MigrationInterface, QueryRunner } from "typeorm";

export class RunContinuations1789979154890 implements MigrationInterface {
    name = 'RunContinuations1789979154890'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text, "checkpointJson" text, "continuationCount" integer NOT NULL DEFAULT (0), "continuationOriginTriggerKind" varchar, "continuationReviewOnly" boolean NOT NULL DEFAULT (0), "continuationDeadlineAt" datetime, "continuationTokensUsed" integer NOT NULL DEFAULT (0), "continuationStopReason" text)`);
        await queryRunner.query(`INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason" FROM "runs"`);
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_677c13cd57721966e5838cea2d"`);
        await queryRunner.query(`DROP INDEX "IDX_7768e812e25e9ce2abd2a65e73"`);
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`ALTER TABLE "runs" RENAME TO "temporary_runs"`);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempt" integer NOT NULL DEFAULT (1), "parentRunId" varchar, "retryAt" datetime, "missedSlots" integer NOT NULL DEFAULT (0), "outcomeVerdict" varchar, "outcomeNote" text, "tokensIn" integer NOT NULL DEFAULT (0), "tokensOut" integer NOT NULL DEFAULT (0), "outcomeCheckedAt" datetime, "checksVerdict" varchar, "checkRemediations" integer NOT NULL DEFAULT (0), "errorKind" varchar, "failureReason" text)`);
        await queryRunner.query(`INSERT INTO "runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent", "dismissedAt", "triggerKind", "attempt", "parentRunId", "retryAt", "missedSlots", "outcomeVerdict", "outcomeNote", "tokensIn", "tokensOut", "outcomeCheckedAt", "checksVerdict", "checkRemediations", "errorKind", "failureReason" FROM "temporary_runs"`);
        await queryRunner.query(`DROP TABLE "temporary_runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
    }

}
