import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionSummaries1791535812457 implements MigrationInterface {
    name = 'DecisionSummaries1791535812457'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_da1e2f94c4a2a884b9688643f7"`);
        await queryRunner.query(`DROP INDEX "IDX_ad199fe6f4f207d0ec75199d39"`);
        await queryRunner.query(`DROP INDEX "IDX_d1f21802ddf797a495d484f640"`);
        await queryRunner.query(`DROP INDEX "IDX_f3a3267c40488e19bf80d79b33"`);
        await queryRunner.query(`CREATE TABLE "temporary_decisions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "routineId" varchar, "runId" varchar, "conversationId" varchar, "title" varchar NOT NULL, "body" text NOT NULL DEFAULT (''), "optionsJson" text NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "urgency" varchar NOT NULL DEFAULT ('normal'), "assigneeUserId" varchar, "chosenOptionId" varchar, "chosenOptionLabel" varchar, "note" text, "decidedByUserId" varchar, "decidedAt" datetime, "expiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "mailThreadId" varchar, "pickupStatus" varchar NOT NULL DEFAULT ('none'), "pickupSummary" text, "pickupStartedAt" datetime, "pickupFinishedAt" datetime, "stallRemindedAt" datetime, "decidedByEmployeeId" varchar, "routedToEmployeeId" varchar, "routedAt" datetime, "snoozedUntil" datetime, "summary" varchar, "recommendation" varchar, "pickupReport" text)`);
        await queryRunner.query(`INSERT INTO "temporary_decisions"("id", "companyId", "employeeId", "routineId", "runId", "conversationId", "title", "body", "optionsJson", "status", "urgency", "assigneeUserId", "chosenOptionId", "chosenOptionLabel", "note", "decidedByUserId", "decidedAt", "expiresAt", "createdAt", "mailThreadId", "pickupStatus", "pickupSummary", "pickupStartedAt", "pickupFinishedAt", "stallRemindedAt", "decidedByEmployeeId", "routedToEmployeeId", "routedAt", "snoozedUntil") SELECT "id", "companyId", "employeeId", "routineId", "runId", "conversationId", "title", "body", "optionsJson", "status", "urgency", "assigneeUserId", "chosenOptionId", "chosenOptionLabel", "note", "decidedByUserId", "decidedAt", "expiresAt", "createdAt", "mailThreadId", "pickupStatus", "pickupSummary", "pickupStartedAt", "pickupFinishedAt", "stallRemindedAt", "decidedByEmployeeId", "routedToEmployeeId", "routedAt", "snoozedUntil" FROM "decisions"`);
        await queryRunner.query(`DROP TABLE "decisions"`);
        await queryRunner.query(`ALTER TABLE "temporary_decisions" RENAME TO "decisions"`);
        await queryRunner.query(`CREATE INDEX "IDX_da1e2f94c4a2a884b9688643f7" ON "decisions" ("status", "snoozedUntil") `);
        await queryRunner.query(`CREATE INDEX "IDX_ad199fe6f4f207d0ec75199d39" ON "decisions" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_d1f21802ddf797a495d484f640" ON "decisions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f3a3267c40488e19bf80d79b33" ON "decisions" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f3a3267c40488e19bf80d79b33"`);
        await queryRunner.query(`DROP INDEX "IDX_d1f21802ddf797a495d484f640"`);
        await queryRunner.query(`DROP INDEX "IDX_ad199fe6f4f207d0ec75199d39"`);
        await queryRunner.query(`DROP INDEX "IDX_da1e2f94c4a2a884b9688643f7"`);
        await queryRunner.query(`ALTER TABLE "decisions" RENAME TO "temporary_decisions"`);
        await queryRunner.query(`CREATE TABLE "decisions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "routineId" varchar, "runId" varchar, "conversationId" varchar, "title" varchar NOT NULL, "body" text NOT NULL DEFAULT (''), "optionsJson" text NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "urgency" varchar NOT NULL DEFAULT ('normal'), "assigneeUserId" varchar, "chosenOptionId" varchar, "chosenOptionLabel" varchar, "note" text, "decidedByUserId" varchar, "decidedAt" datetime, "expiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "mailThreadId" varchar, "pickupStatus" varchar NOT NULL DEFAULT ('none'), "pickupSummary" text, "pickupStartedAt" datetime, "pickupFinishedAt" datetime, "stallRemindedAt" datetime, "decidedByEmployeeId" varchar, "routedToEmployeeId" varchar, "routedAt" datetime, "snoozedUntil" datetime)`);
        await queryRunner.query(`INSERT INTO "decisions"("id", "companyId", "employeeId", "routineId", "runId", "conversationId", "title", "body", "optionsJson", "status", "urgency", "assigneeUserId", "chosenOptionId", "chosenOptionLabel", "note", "decidedByUserId", "decidedAt", "expiresAt", "createdAt", "mailThreadId", "pickupStatus", "pickupSummary", "pickupStartedAt", "pickupFinishedAt", "stallRemindedAt", "decidedByEmployeeId", "routedToEmployeeId", "routedAt", "snoozedUntil") SELECT "id", "companyId", "employeeId", "routineId", "runId", "conversationId", "title", "body", "optionsJson", "status", "urgency", "assigneeUserId", "chosenOptionId", "chosenOptionLabel", "note", "decidedByUserId", "decidedAt", "expiresAt", "createdAt", "mailThreadId", "pickupStatus", "pickupSummary", "pickupStartedAt", "pickupFinishedAt", "stallRemindedAt", "decidedByEmployeeId", "routedToEmployeeId", "routedAt", "snoozedUntil" FROM "temporary_decisions"`);
        await queryRunner.query(`DROP TABLE "temporary_decisions"`);
        await queryRunner.query(`CREATE INDEX "IDX_f3a3267c40488e19bf80d79b33" ON "decisions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d1f21802ddf797a495d484f640" ON "decisions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ad199fe6f4f207d0ec75199d39" ON "decisions" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_da1e2f94c4a2a884b9688643f7" ON "decisions" ("status", "snoozedUntil") `);
    }

}
