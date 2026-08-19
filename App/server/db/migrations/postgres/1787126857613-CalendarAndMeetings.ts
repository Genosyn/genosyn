import { MigrationInterface, QueryRunner } from "typeorm";

export class CalendarAndMeetings1787126857613 implements MigrationInterface {
    name = 'CalendarAndMeetings1787126857613'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "calendar_accounts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "connectionId" character varying NOT NULL, "calendarId" character varying NOT NULL DEFAULT 'primary', "address" character varying NOT NULL DEFAULT '', "displayName" character varying NOT NULL DEFAULT '', "timeZone" character varying NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'active', "statusMessage" character varying NOT NULL DEFAULT '', "syncToken" character varying NOT NULL DEFAULT '', "syncState" character varying NOT NULL DEFAULT 'idle', "syncAttemptId" character varying, "syncStartedAt" TIMESTAMP WITH TIME ZONE, "syncFinishedAt" TIMESTAMP WITH TIME ZONE, "lastSyncAt" TIMESTAMP WITH TIME ZONE, "windowDays" integer NOT NULL DEFAULT '60', "autoRecord" character varying NOT NULL DEFAULT 'off', "notetakerEmployeeId" character varying, "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_982e199babbc2c4304722ca279e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_45bc8d9a8adf06ebab117a9a7d" ON "calendar_accounts" ("connectionId", "calendarId") `);
        await queryRunner.query(`CREATE INDEX "IDX_436b36a4da5c995c635f5cb9fd" ON "calendar_accounts" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "calendar_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "accountId" character varying NOT NULL, "externalId" character varying NOT NULL, "iCalUid" character varying NOT NULL DEFAULT '', "recurringEventId" character varying NOT NULL DEFAULT '', "summary" character varying NOT NULL DEFAULT '', "description" text NOT NULL DEFAULT '', "location" character varying NOT NULL DEFAULT '', "startAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endAt" TIMESTAMP WITH TIME ZONE NOT NULL, "allDay" boolean NOT NULL DEFAULT false, "status" character varying NOT NULL DEFAULT 'confirmed', "organizerEmail" character varying NOT NULL DEFAULT '', "organizerName" character varying NOT NULL DEFAULT '', "attendeesJson" text NOT NULL DEFAULT '[]', "conferenceProvider" character varying NOT NULL DEFAULT 'none', "conferenceUrl" character varying NOT NULL DEFAULT '', "htmlLink" character varying NOT NULL DEFAULT '', "remoteUpdatedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_faf5391d232322a87cdd1c6f30c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e13466c5ed7dc556902e6e4e95" ON "calendar_events" ("companyId", "iCalUid") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_25be8b4470e17d7e249431466c" ON "calendar_events" ("accountId", "externalId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1c511d4590a1b467cd62a86c07" ON "calendar_events" ("accountId", "startAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_241fbd1197c1673524a55d6e86" ON "calendar_events" ("companyId", "startAt") `);
        await queryRunner.query(`CREATE TABLE "meetings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "calendarEventId" character varying, "accountId" character varying, "title" character varying NOT NULL DEFAULT '', "scheduledStartAt" TIMESTAMP WITH TIME ZONE, "scheduledEndAt" TIMESTAMP WITH TIME ZONE, "startedAt" TIMESTAMP WITH TIME ZONE, "endedAt" TIMESTAMP WITH TIME ZONE, "conferenceProvider" character varying NOT NULL DEFAULT 'none', "conferenceUrl" character varying NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'scheduled', "statusMessage" character varying NOT NULL DEFAULT '', "recordingSource" character varying NOT NULL DEFAULT 'none', "recordingPath" character varying NOT NULL DEFAULT '', "recordingMime" character varying NOT NULL DEFAULT '', "recordingBytes" bigint NOT NULL DEFAULT '0', "durationMs" integer NOT NULL DEFAULT '0', "transcriptState" character varying NOT NULL DEFAULT 'none', "transcriptError" character varying NOT NULL DEFAULT '', "transcriptText" text NOT NULL DEFAULT '', "summaryText" text NOT NULL DEFAULT '', "actionItemsJson" text NOT NULL DEFAULT '[]', "notetakerEmployeeId" character varying, "linkedAt" TIMESTAMP WITH TIME ZONE, "summarisedAt" TIMESTAMP WITH TIME ZONE, "customerId" character varying, "dealId" character varying, "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_aa73be861afa77eb4ed31f3ed57" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4d6dc2c99550173c2d461dec60" ON "meetings" ("calendarEventId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9073286a8f7b0ec5c0c384b3a1" ON "meetings" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5b750f7d4ca2dc23eeba1e58e7" ON "meetings" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_0e385ab60bd1fabbc866e9aa8a" ON "meetings" ("companyId", "scheduledStartAt") `);
        await queryRunner.query(`CREATE TABLE "meeting_participants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "meetingId" character varying NOT NULL, "email" character varying NOT NULL, "displayName" character varying NOT NULL DEFAULT '', "contactId" character varying, "isOrganizer" boolean NOT NULL DEFAULT false, "isInternal" boolean NOT NULL DEFAULT false, "responseStatus" character varying NOT NULL DEFAULT '', "speakerLabel" character varying NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_994ee66a92de655fb478c038980" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_842b92823ff8e2e936f7dd4ded" ON "meeting_participants" ("meetingId", "email") `);
        await queryRunner.query(`CREATE INDEX "IDX_ed4dccefb8bc314d8b86db6950" ON "meeting_participants" ("contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_27e0f3d67470918e58ef3db660" ON "meeting_participants" ("companyId", "email") `);
        await queryRunner.query(`CREATE INDEX "IDX_73193d0c84f0a62e423fc51302" ON "meeting_participants" ("meetingId") `);
        await queryRunner.query(`CREATE TABLE "meeting_transcript_segments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "meetingId" character varying NOT NULL, "sortOrder" integer NOT NULL DEFAULT '0', "startMs" integer NOT NULL DEFAULT '0', "endMs" integer NOT NULL DEFAULT '0', "speaker" character varying NOT NULL DEFAULT '', "text" text NOT NULL DEFAULT '', CONSTRAINT "PK_8fbe858628314386b1cb372d864" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_01114f261214e843a1e0cf472a" ON "meeting_transcript_segments" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eabc774e9f3d585771650d8c8f" ON "meeting_transcript_segments" ("meetingId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "employee_calendar_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "employeeId" character varying NOT NULL, "accountId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_279c76a1bffd874a152f6a3b43a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_88810e60bc4f75ea6e940182bc" ON "employee_calendar_grants" ("employeeId", "accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d66d1609d5417951eb6ce365d" ON "employee_calendar_grants" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d21440e62c3f48ae01dd9f03e" ON "employee_calendar_grants" ("employeeId") `);
        await queryRunner.query(`ALTER TABLE "activities" ADD "meetingId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_5a31151a82c27b7bf3d3fc847c" ON "activities" ("companyId", "meetingId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5a31151a82c27b7bf3d3fc847c"`);
        await queryRunner.query(`ALTER TABLE "activities" DROP COLUMN "meetingId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d21440e62c3f48ae01dd9f03e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d66d1609d5417951eb6ce365d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_88810e60bc4f75ea6e940182bc"`);
        await queryRunner.query(`DROP TABLE "employee_calendar_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eabc774e9f3d585771650d8c8f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_01114f261214e843a1e0cf472a"`);
        await queryRunner.query(`DROP TABLE "meeting_transcript_segments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_73193d0c84f0a62e423fc51302"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_27e0f3d67470918e58ef3db660"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ed4dccefb8bc314d8b86db6950"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_842b92823ff8e2e936f7dd4ded"`);
        await queryRunner.query(`DROP TABLE "meeting_participants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0e385ab60bd1fabbc866e9aa8a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5b750f7d4ca2dc23eeba1e58e7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9073286a8f7b0ec5c0c384b3a1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4d6dc2c99550173c2d461dec60"`);
        await queryRunner.query(`DROP TABLE "meetings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_241fbd1197c1673524a55d6e86"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1c511d4590a1b467cd62a86c07"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_25be8b4470e17d7e249431466c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e13466c5ed7dc556902e6e4e95"`);
        await queryRunner.query(`DROP TABLE "calendar_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_436b36a4da5c995c635f5cb9fd"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_45bc8d9a8adf06ebab117a9a7d"`);
        await queryRunner.query(`DROP TABLE "calendar_accounts"`);
    }

}
