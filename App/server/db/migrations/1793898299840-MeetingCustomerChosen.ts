import { MigrationInterface, QueryRunner } from "typeorm";

export class MeetingCustomerChosen1793898299840 implements MigrationInterface {
    name = 'MeetingCustomerChosen1793898299840'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0e385ab60bd1fabbc866e9aa8a"`);
        await queryRunner.query(`DROP INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7"`);
        await queryRunner.query(`DROP INDEX "IDX_9073286a8f7b0ec5c0c384b3a1"`);
        await queryRunner.query(`DROP INDEX "IDX_4d6dc2c99550173c2d461dec60"`);
        await queryRunner.query(`CREATE TABLE "temporary_meetings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "calendarEventId" varchar, "accountId" varchar, "title" varchar NOT NULL DEFAULT (''), "scheduledStartAt" datetime, "scheduledEndAt" datetime, "startedAt" datetime, "endedAt" datetime, "conferenceProvider" varchar NOT NULL DEFAULT ('none'), "conferenceUrl" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('scheduled'), "statusMessage" varchar NOT NULL DEFAULT (''), "recordingSource" varchar NOT NULL DEFAULT ('none'), "recordingPath" varchar NOT NULL DEFAULT (''), "recordingMime" varchar NOT NULL DEFAULT (''), "recordingBytes" bigint NOT NULL DEFAULT (0), "durationMs" integer NOT NULL DEFAULT (0), "transcriptState" varchar NOT NULL DEFAULT ('none'), "transcriptError" varchar NOT NULL DEFAULT (''), "transcriptText" text NOT NULL DEFAULT (''), "summaryText" text NOT NULL DEFAULT (''), "actionItemsJson" text NOT NULL DEFAULT ('[]'), "notetakerEmployeeId" varchar, "linkedAt" datetime, "summarisedAt" datetime, "customerId" varchar, "dealId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "customerChosen" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_meetings"("id", "companyId", "calendarEventId", "accountId", "title", "scheduledStartAt", "scheduledEndAt", "startedAt", "endedAt", "conferenceProvider", "conferenceUrl", "status", "statusMessage", "recordingSource", "recordingPath", "recordingMime", "recordingBytes", "durationMs", "transcriptState", "transcriptError", "transcriptText", "summaryText", "actionItemsJson", "notetakerEmployeeId", "linkedAt", "summarisedAt", "customerId", "dealId", "createdByUserId", "createdAt", "updatedAt") SELECT "id", "companyId", "calendarEventId", "accountId", "title", "scheduledStartAt", "scheduledEndAt", "startedAt", "endedAt", "conferenceProvider", "conferenceUrl", "status", "statusMessage", "recordingSource", "recordingPath", "recordingMime", "recordingBytes", "durationMs", "transcriptState", "transcriptError", "transcriptText", "summaryText", "actionItemsJson", "notetakerEmployeeId", "linkedAt", "summarisedAt", "customerId", "dealId", "createdByUserId", "createdAt", "updatedAt" FROM "meetings"`);
        await queryRunner.query(`DROP TABLE "meetings"`);
        await queryRunner.query(`ALTER TABLE "temporary_meetings" RENAME TO "meetings"`);
        await queryRunner.query(`CREATE INDEX "IDX_0e385ab60bd1fabbc866e9aa8a" ON "meetings" ("companyId", "scheduledStartAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7" ON "meetings" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_9073286a8f7b0ec5c0c384b3a1" ON "meetings" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4d6dc2c99550173c2d461dec60" ON "meetings" ("calendarEventId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_4d6dc2c99550173c2d461dec60"`);
        await queryRunner.query(`DROP INDEX "IDX_9073286a8f7b0ec5c0c384b3a1"`);
        await queryRunner.query(`DROP INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7"`);
        await queryRunner.query(`DROP INDEX "IDX_0e385ab60bd1fabbc866e9aa8a"`);
        await queryRunner.query(`ALTER TABLE "meetings" RENAME TO "temporary_meetings"`);
        await queryRunner.query(`CREATE TABLE "meetings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "calendarEventId" varchar, "accountId" varchar, "title" varchar NOT NULL DEFAULT (''), "scheduledStartAt" datetime, "scheduledEndAt" datetime, "startedAt" datetime, "endedAt" datetime, "conferenceProvider" varchar NOT NULL DEFAULT ('none'), "conferenceUrl" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('scheduled'), "statusMessage" varchar NOT NULL DEFAULT (''), "recordingSource" varchar NOT NULL DEFAULT ('none'), "recordingPath" varchar NOT NULL DEFAULT (''), "recordingMime" varchar NOT NULL DEFAULT (''), "recordingBytes" bigint NOT NULL DEFAULT (0), "durationMs" integer NOT NULL DEFAULT (0), "transcriptState" varchar NOT NULL DEFAULT ('none'), "transcriptError" varchar NOT NULL DEFAULT (''), "transcriptText" text NOT NULL DEFAULT (''), "summaryText" text NOT NULL DEFAULT (''), "actionItemsJson" text NOT NULL DEFAULT ('[]'), "notetakerEmployeeId" varchar, "linkedAt" datetime, "summarisedAt" datetime, "customerId" varchar, "dealId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "meetings"("id", "companyId", "calendarEventId", "accountId", "title", "scheduledStartAt", "scheduledEndAt", "startedAt", "endedAt", "conferenceProvider", "conferenceUrl", "status", "statusMessage", "recordingSource", "recordingPath", "recordingMime", "recordingBytes", "durationMs", "transcriptState", "transcriptError", "transcriptText", "summaryText", "actionItemsJson", "notetakerEmployeeId", "linkedAt", "summarisedAt", "customerId", "dealId", "createdByUserId", "createdAt", "updatedAt") SELECT "id", "companyId", "calendarEventId", "accountId", "title", "scheduledStartAt", "scheduledEndAt", "startedAt", "endedAt", "conferenceProvider", "conferenceUrl", "status", "statusMessage", "recordingSource", "recordingPath", "recordingMime", "recordingBytes", "durationMs", "transcriptState", "transcriptError", "transcriptText", "summaryText", "actionItemsJson", "notetakerEmployeeId", "linkedAt", "summarisedAt", "customerId", "dealId", "createdByUserId", "createdAt", "updatedAt" FROM "temporary_meetings"`);
        await queryRunner.query(`DROP TABLE "temporary_meetings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4d6dc2c99550173c2d461dec60" ON "meetings" ("calendarEventId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9073286a8f7b0ec5c0c384b3a1" ON "meetings" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7" ON "meetings" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_0e385ab60bd1fabbc866e9aa8a" ON "meetings" ("companyId", "scheduledStartAt") `);
    }

}
