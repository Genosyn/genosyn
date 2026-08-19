import { MigrationInterface, QueryRunner } from "typeorm";

export class CalendarAndMeetings1787126827371 implements MigrationInterface {
    name = 'CalendarAndMeetings1787126827371'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "calendar_accounts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "calendarId" varchar NOT NULL DEFAULT ('primary'), "address" varchar NOT NULL DEFAULT (''), "displayName" varchar NOT NULL DEFAULT (''), "timeZone" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('active'), "statusMessage" varchar NOT NULL DEFAULT (''), "syncToken" varchar NOT NULL DEFAULT (''), "syncState" varchar NOT NULL DEFAULT ('idle'), "syncAttemptId" varchar, "syncStartedAt" datetime, "syncFinishedAt" datetime, "lastSyncAt" datetime, "windowDays" integer NOT NULL DEFAULT (60), "autoRecord" varchar NOT NULL DEFAULT ('off'), "notetakerEmployeeId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_45bc8d9a8adf06ebab117a9a7d" ON "calendar_accounts" ("connectionId", "calendarId") `);
        await queryRunner.query(`CREATE INDEX "IDX_436b36a4da5c995c635f5cb9fd" ON "calendar_accounts" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "calendar_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "externalId" varchar NOT NULL, "iCalUid" varchar NOT NULL DEFAULT (''), "recurringEventId" varchar NOT NULL DEFAULT (''), "summary" varchar NOT NULL DEFAULT (''), "description" text NOT NULL DEFAULT (''), "location" varchar NOT NULL DEFAULT (''), "startAt" datetime NOT NULL, "endAt" datetime NOT NULL, "allDay" boolean NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('confirmed'), "organizerEmail" varchar NOT NULL DEFAULT (''), "organizerName" varchar NOT NULL DEFAULT (''), "attendeesJson" text NOT NULL DEFAULT ('[]'), "conferenceProvider" varchar NOT NULL DEFAULT ('none'), "conferenceUrl" varchar NOT NULL DEFAULT (''), "htmlLink" varchar NOT NULL DEFAULT (''), "remoteUpdatedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_e13466c5ed7dc556902e6e4e95" ON "calendar_events" ("companyId", "iCalUid") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_25be8b4470e17d7e249431466c" ON "calendar_events" ("accountId", "externalId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1c511d4590a1b467cd62a86c07" ON "calendar_events" ("accountId", "startAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_241fbd1197c1673524a55d6e86" ON "calendar_events" ("companyId", "startAt") `);
        await queryRunner.query(`CREATE TABLE "meetings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "calendarEventId" varchar, "accountId" varchar, "title" varchar NOT NULL DEFAULT (''), "scheduledStartAt" datetime, "scheduledEndAt" datetime, "startedAt" datetime, "endedAt" datetime, "conferenceProvider" varchar NOT NULL DEFAULT ('none'), "conferenceUrl" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('scheduled'), "statusMessage" varchar NOT NULL DEFAULT (''), "recordingSource" varchar NOT NULL DEFAULT ('none'), "recordingPath" varchar NOT NULL DEFAULT (''), "recordingMime" varchar NOT NULL DEFAULT (''), "recordingBytes" bigint NOT NULL DEFAULT (0), "durationMs" integer NOT NULL DEFAULT (0), "transcriptState" varchar NOT NULL DEFAULT ('none'), "transcriptError" varchar NOT NULL DEFAULT (''), "transcriptText" text NOT NULL DEFAULT (''), "summaryText" text NOT NULL DEFAULT (''), "actionItemsJson" text NOT NULL DEFAULT ('[]'), "notetakerEmployeeId" varchar, "linkedAt" datetime, "summarisedAt" datetime, "customerId" varchar, "dealId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4d6dc2c99550173c2d461dec60" ON "meetings" ("calendarEventId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9073286a8f7b0ec5c0c384b3a1" ON "meetings" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7" ON "meetings" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_0e385ab60bd1fabbc866e9aa8a" ON "meetings" ("companyId", "scheduledStartAt") `);
        await queryRunner.query(`CREATE TABLE "meeting_participants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "meetingId" varchar NOT NULL, "email" varchar NOT NULL, "displayName" varchar NOT NULL DEFAULT (''), "contactId" varchar, "isOrganizer" boolean NOT NULL DEFAULT (0), "isInternal" boolean NOT NULL DEFAULT (0), "responseStatus" varchar NOT NULL DEFAULT (''), "speakerLabel" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_842b92823ff8e2e936f7dd4ded" ON "meeting_participants" ("meetingId", "email") `);
        await queryRunner.query(`CREATE INDEX "IDX_ed4dccefb8bc314d8b86db6950" ON "meeting_participants" ("contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_27e0f3d67470918e58ef3db660" ON "meeting_participants" ("companyId", "email") `);
        await queryRunner.query(`CREATE INDEX "IDX_73193d0c84f0a62e423fc51302" ON "meeting_participants" ("meetingId") `);
        await queryRunner.query(`CREATE TABLE "meeting_transcript_segments" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "meetingId" varchar NOT NULL, "sortOrder" integer NOT NULL DEFAULT (0), "startMs" integer NOT NULL DEFAULT (0), "endMs" integer NOT NULL DEFAULT (0), "speaker" varchar NOT NULL DEFAULT (''), "text" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_01114f261214e843a1e0cf472a" ON "meeting_transcript_segments" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eabc774e9f3d585771650d8c8f" ON "meeting_transcript_segments" ("meetingId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "employee_calendar_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "accountId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_88810e60bc4f75ea6e940182bc" ON "employee_calendar_grants" ("employeeId", "accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d66d1609d5417951eb6ce365d" ON "employee_calendar_grants" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d21440e62c3f48ae01dd9f03e" ON "employee_calendar_grants" ("employeeId") `);
        await queryRunner.query(`DROP INDEX "IDX_dcfba5f8376b0161f592f0530a"`);
        await queryRunner.query(`DROP INDEX "IDX_c89d0d47933afc5511e84a9e56"`);
        await queryRunner.query(`DROP INDEX "IDX_47d9a8dbb573521810a5b2c3dc"`);
        await queryRunner.query(`DROP INDEX "IDX_2bddf29f25d4a1752ea6eadc63"`);
        await queryRunner.query(`DROP INDEX "IDX_0475b6d437b908dac4a4e768b5"`);
        await queryRunner.query(`DROP INDEX "IDX_823726e0acc9be30241813fbf7"`);
        await queryRunner.query(`DROP INDEX "IDX_5383feac2144f5b54f1ff44094"`);
        await queryRunner.query(`DROP INDEX "IDX_94aa9cdb289d03202f0bf2bfef"`);
        await queryRunner.query(`CREATE TABLE "temporary_activities" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "subject" varchar NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "occurredAt" datetime NOT NULL, "contactId" varchar, "dealId" varchar, "customerId" varchar, "mailThreadId" varchar, "mailMessageId" varchar, "actorUserId" varchar, "actorEmployeeId" varchar, "metaJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "partnershipId" varchar, "taskStatus" varchar, "dueAt" datetime, "completedAt" datetime, "assignedUserId" varchar, "assignedEmployeeId" varchar, "priority" varchar, "reminderAt" datetime, "recurrenceRule" varchar, "meetingId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_activities"("id", "companyId", "kind", "subject", "bodyText", "occurredAt", "contactId", "dealId", "customerId", "mailThreadId", "mailMessageId", "actorUserId", "actorEmployeeId", "metaJson", "createdAt", "partnershipId", "taskStatus", "dueAt", "completedAt", "assignedUserId", "assignedEmployeeId", "priority", "reminderAt", "recurrenceRule") SELECT "id", "companyId", "kind", "subject", "bodyText", "occurredAt", "contactId", "dealId", "customerId", "mailThreadId", "mailMessageId", "actorUserId", "actorEmployeeId", "metaJson", "createdAt", "partnershipId", "taskStatus", "dueAt", "completedAt", "assignedUserId", "assignedEmployeeId", "priority", "reminderAt", "recurrenceRule" FROM "activities"`);
        await queryRunner.query(`DROP TABLE "activities"`);
        await queryRunner.query(`ALTER TABLE "temporary_activities" RENAME TO "activities"`);
        await queryRunner.query(`CREATE INDEX "IDX_dcfba5f8376b0161f592f0530a" ON "activities" ("partnershipId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_c89d0d47933afc5511e84a9e56" ON "activities" ("companyId", "taskStatus", "dueAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_47d9a8dbb573521810a5b2c3dc" ON "activities" ("companyId", "mailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2bddf29f25d4a1752ea6eadc63" ON "activities" ("customerId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_0475b6d437b908dac4a4e768b5" ON "activities" ("dealId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_823726e0acc9be30241813fbf7" ON "activities" ("contactId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5383feac2144f5b54f1ff44094" ON "activities" ("companyId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_94aa9cdb289d03202f0bf2bfef" ON "activities" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5a31151a82c27b7bf3d3fc847c" ON "activities" ("companyId", "meetingId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5a31151a82c27b7bf3d3fc847c"`);
        await queryRunner.query(`DROP INDEX "IDX_94aa9cdb289d03202f0bf2bfef"`);
        await queryRunner.query(`DROP INDEX "IDX_5383feac2144f5b54f1ff44094"`);
        await queryRunner.query(`DROP INDEX "IDX_823726e0acc9be30241813fbf7"`);
        await queryRunner.query(`DROP INDEX "IDX_0475b6d437b908dac4a4e768b5"`);
        await queryRunner.query(`DROP INDEX "IDX_2bddf29f25d4a1752ea6eadc63"`);
        await queryRunner.query(`DROP INDEX "IDX_47d9a8dbb573521810a5b2c3dc"`);
        await queryRunner.query(`DROP INDEX "IDX_c89d0d47933afc5511e84a9e56"`);
        await queryRunner.query(`DROP INDEX "IDX_dcfba5f8376b0161f592f0530a"`);
        await queryRunner.query(`ALTER TABLE "activities" RENAME TO "temporary_activities"`);
        await queryRunner.query(`CREATE TABLE "activities" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "subject" varchar NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "occurredAt" datetime NOT NULL, "contactId" varchar, "dealId" varchar, "customerId" varchar, "mailThreadId" varchar, "mailMessageId" varchar, "actorUserId" varchar, "actorEmployeeId" varchar, "metaJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "partnershipId" varchar, "taskStatus" varchar, "dueAt" datetime, "completedAt" datetime, "assignedUserId" varchar, "assignedEmployeeId" varchar, "priority" varchar, "reminderAt" datetime, "recurrenceRule" varchar)`);
        await queryRunner.query(`INSERT INTO "activities"("id", "companyId", "kind", "subject", "bodyText", "occurredAt", "contactId", "dealId", "customerId", "mailThreadId", "mailMessageId", "actorUserId", "actorEmployeeId", "metaJson", "createdAt", "partnershipId", "taskStatus", "dueAt", "completedAt", "assignedUserId", "assignedEmployeeId", "priority", "reminderAt", "recurrenceRule") SELECT "id", "companyId", "kind", "subject", "bodyText", "occurredAt", "contactId", "dealId", "customerId", "mailThreadId", "mailMessageId", "actorUserId", "actorEmployeeId", "metaJson", "createdAt", "partnershipId", "taskStatus", "dueAt", "completedAt", "assignedUserId", "assignedEmployeeId", "priority", "reminderAt", "recurrenceRule" FROM "temporary_activities"`);
        await queryRunner.query(`DROP TABLE "temporary_activities"`);
        await queryRunner.query(`CREATE INDEX "IDX_94aa9cdb289d03202f0bf2bfef" ON "activities" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5383feac2144f5b54f1ff44094" ON "activities" ("companyId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_823726e0acc9be30241813fbf7" ON "activities" ("contactId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_0475b6d437b908dac4a4e768b5" ON "activities" ("dealId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_2bddf29f25d4a1752ea6eadc63" ON "activities" ("customerId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_47d9a8dbb573521810a5b2c3dc" ON "activities" ("companyId", "mailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c89d0d47933afc5511e84a9e56" ON "activities" ("companyId", "taskStatus", "dueAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_dcfba5f8376b0161f592f0530a" ON "activities" ("partnershipId", "occurredAt") `);
        await queryRunner.query(`DROP INDEX "IDX_8d21440e62c3f48ae01dd9f03e"`);
        await queryRunner.query(`DROP INDEX "IDX_8d66d1609d5417951eb6ce365d"`);
        await queryRunner.query(`DROP INDEX "IDX_88810e60bc4f75ea6e940182bc"`);
        await queryRunner.query(`DROP TABLE "employee_calendar_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_eabc774e9f3d585771650d8c8f"`);
        await queryRunner.query(`DROP INDEX "IDX_01114f261214e843a1e0cf472a"`);
        await queryRunner.query(`DROP TABLE "meeting_transcript_segments"`);
        await queryRunner.query(`DROP INDEX "IDX_73193d0c84f0a62e423fc51302"`);
        await queryRunner.query(`DROP INDEX "IDX_27e0f3d67470918e58ef3db660"`);
        await queryRunner.query(`DROP INDEX "IDX_ed4dccefb8bc314d8b86db6950"`);
        await queryRunner.query(`DROP INDEX "IDX_842b92823ff8e2e936f7dd4ded"`);
        await queryRunner.query(`DROP TABLE "meeting_participants"`);
        await queryRunner.query(`DROP INDEX "IDX_0e385ab60bd1fabbc866e9aa8a"`);
        await queryRunner.query(`DROP INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7"`);
        await queryRunner.query(`DROP INDEX "IDX_9073286a8f7b0ec5c0c384b3a1"`);
        await queryRunner.query(`DROP INDEX "IDX_4d6dc2c99550173c2d461dec60"`);
        await queryRunner.query(`DROP TABLE "meetings"`);
        await queryRunner.query(`DROP INDEX "IDX_241fbd1197c1673524a55d6e86"`);
        await queryRunner.query(`DROP INDEX "IDX_1c511d4590a1b467cd62a86c07"`);
        await queryRunner.query(`DROP INDEX "IDX_25be8b4470e17d7e249431466c"`);
        await queryRunner.query(`DROP INDEX "IDX_e13466c5ed7dc556902e6e4e95"`);
        await queryRunner.query(`DROP TABLE "calendar_events"`);
        await queryRunner.query(`DROP INDEX "IDX_436b36a4da5c995c635f5cb9fd"`);
        await queryRunner.query(`DROP INDEX "IDX_45bc8d9a8adf06ebab117a9a7d"`);
        await queryRunner.query(`DROP TABLE "calendar_accounts"`);
    }

}
