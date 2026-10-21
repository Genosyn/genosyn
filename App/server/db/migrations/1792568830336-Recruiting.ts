import { MigrationInterface, QueryRunner } from "typeorm";

export class Recruiting1792568830336 implements MigrationInterface {
    name = 'Recruiting1792568830336'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "recruiting_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "siteEnabled" boolean NOT NULL DEFAULT (0), "siteVisibility" varchar NOT NULL DEFAULT ('public'), "siteTitle" varchar NOT NULL DEFAULT (''), "siteHeadline" varchar NOT NULL DEFAULT (''), "websiteUrl" varchar NOT NULL DEFAULT (''), "privacyPolicyUrl" varchar NOT NULL DEFAULT (''), "accentColor" varchar NOT NULL DEFAULT ('#4f46e5'), "logoKey" varchar, "allowIndexing" boolean NOT NULL DEFAULT (1), "customDomain" varchar, "customDomainToken" varchar, "customDomainVerifiedAt" datetime, "customDomainCheckedAt" datetime, "screenerEmployeeId" varchar, "autoScreen" boolean NOT NULL DEFAULT (1), "confirmationEmailEnabled" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "customDomainError" text NOT NULL DEFAULT (''), "siteIntro" text NOT NULL DEFAULT (''), "screeningInstructions" text, "confirmationEmailSubject" text, "confirmationEmailBody" text, "rejectionEmailSubject" text, "rejectionEmailBody" text)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_78b5a927f5a10c28b1d4405b9f" ON "recruiting_settings" ("customDomain") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2dc06106c31ef0d23eb29c1a56" ON "recruiting_settings" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "recruiting_openings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "slug" varchar NOT NULL, "title" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('draft'), "visibility" varchar NOT NULL DEFAULT ('public'), "employmentType" varchar NOT NULL DEFAULT ('full_time'), "workplace" varchar NOT NULL DEFAULT ('onsite'), "department" varchar NOT NULL DEFAULT (''), "location" varchar NOT NULL DEFAULT (''), "compensationMinMinor" bigint, "compensationMaxMinor" bigint, "compensationCurrency" varchar NOT NULL DEFAULT ('USD'), "compensationPeriod" varchar NOT NULL DEFAULT ('year'), "headcount" integer NOT NULL DEFAULT (1), "applyBy" datetime, "screenerEmployeeId" varchar, "ownerUserId" varchar, "createdByUserId" varchar, "createdByEmployeeId" varchar, "criteriaSource" varchar NOT NULL DEFAULT ('member'), "criteriaByEmployeeId" varchar, "criteriaUpdatedAt" datetime, "publishedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "summary" text NOT NULL DEFAULT (''), "formJson" text NOT NULL DEFAULT ('{}'), "criteriaJson" text NOT NULL DEFAULT ('[]'), "questionsJson" text NOT NULL DEFAULT ('[]'), "description" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_96d4badc29680ef2b9f4df4ed6" ON "recruiting_openings" ("companyId", "status", "updatedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9449471c580922f5bd37190f46" ON "recruiting_openings" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "recruiting_applications" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "openingId" varchar NOT NULL, "candidateName" varchar NOT NULL, "candidateEmail" varchar NOT NULL, "candidatePhone" varchar NOT NULL DEFAULT (''), "candidateLocation" varchar NOT NULL DEFAULT (''), "linkedinUrl" varchar NOT NULL DEFAULT (''), "websiteUrl" varchar NOT NULL DEFAULT (''), "source" varchar NOT NULL DEFAULT ('careers_site'), "sourceDetail" varchar NOT NULL DEFAULT (''), "applicantUserId" varchar, "createdByUserId" varchar, "createdByEmployeeId" varchar, "stage" varchar NOT NULL DEFAULT ('applied'), "stageChangedAt" datetime NOT NULL, "rejectionReason" varchar NOT NULL DEFAULT (''), "screenStatus" varchar NOT NULL DEFAULT ('none'), "screenAttempts" integer NOT NULL DEFAULT (0), "screenQueuedAt" datetime, "screenStartedAt" datetime, "score" integer, "scoreLabel" varchar, "scoredAt" datetime, "latestScorecardId" varchar, "injectionFlag" boolean NOT NULL DEFAULT (0), "confirmationEmailStatus" varchar NOT NULL DEFAULT (''), "consentAt" datetime, "clientSubmissionId" varchar, "resumeFileKey" varchar, "resumeFileName" varchar NOT NULL DEFAULT (''), "resumeMimeType" varchar NOT NULL DEFAULT (''), "resumeSize" integer NOT NULL DEFAULT (0), "resumeTextStatus" varchar NOT NULL DEFAULT ('none'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "screenError" text NOT NULL DEFAULT (''), "answersJson" text NOT NULL DEFAULT ('[]'), "coverLetter" text NOT NULL DEFAULT (''), "resumeText" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_0dd73fdce6baa0a78d14f1741e" ON "recruiting_applications" ("screenStatus", "screenQueuedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a796da754d67590d2efd91ea9" ON "recruiting_applications" ("companyId", "candidateEmail") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b655b28530b092f69cc406adb6" ON "recruiting_applications" ("openingId", "clientSubmissionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab8483b0128d5ac386c78d8f70" ON "recruiting_applications" ("openingId", "stage", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a1ce15f3420232b32ede42fdcc" ON "recruiting_applications" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "recruiting_scorecards" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "openingId" varchar NOT NULL, "applicationId" varchar NOT NULL, "authorKind" varchar NOT NULL, "authorEmployeeId" varchar, "authorUserId" varchar, "authorName" varchar NOT NULL DEFAULT (''), "score" integer, "label" varchar, "criteriaFingerprint" varchar NOT NULL DEFAULT (''), "unverifiedQuotes" integer NOT NULL DEFAULT (0), "injectionDetected" boolean NOT NULL DEFAULT (0), "modelLabel" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "summary" text NOT NULL DEFAULT (''), "ratingsJson" text NOT NULL DEFAULT ('[]'), "strengthsJson" text NOT NULL DEFAULT ('[]'), "concernsJson" text NOT NULL DEFAULT ('[]'), "interviewQuestionsJson" text NOT NULL DEFAULT ('[]'))`);
        await queryRunner.query(`CREATE INDEX "IDX_79d44ad94ef6ff412512d78ee4" ON "recruiting_scorecards" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_1230eb436aeb86f65c881eb1be" ON "recruiting_scorecards" ("applicationId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "recruiting_application_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "openingId" varchar NOT NULL, "applicationId" varchar NOT NULL, "kind" varchar NOT NULL, "actorKind" varchar NOT NULL, "actorUserId" varchar, "actorEmployeeId" varchar, "actorName" varchar NOT NULL DEFAULT (''), "fromStage" varchar, "toStage" varchar, "occurredAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "metaJson" text NOT NULL DEFAULT ('{}'), "body" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_8f4b27bf92c1ff24d8d63cb747" ON "recruiting_application_events" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_e832b264db426cb176befa3b20" ON "recruiting_application_events" ("applicationId", "occurredAt") `);
        await queryRunner.query(`CREATE TABLE "employee_recruiting_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_45b78ecf11cfd7882e96de1d28" ON "employee_recruiting_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f53aae70f8ba0dd3743c26aeff" ON "employee_recruiting_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f53aae70f8ba0dd3743c26aeff"`);
        await queryRunner.query(`DROP INDEX "IDX_45b78ecf11cfd7882e96de1d28"`);
        await queryRunner.query(`DROP TABLE "employee_recruiting_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_e832b264db426cb176befa3b20"`);
        await queryRunner.query(`DROP INDEX "IDX_8f4b27bf92c1ff24d8d63cb747"`);
        await queryRunner.query(`DROP TABLE "recruiting_application_events"`);
        await queryRunner.query(`DROP INDEX "IDX_1230eb436aeb86f65c881eb1be"`);
        await queryRunner.query(`DROP INDEX "IDX_79d44ad94ef6ff412512d78ee4"`);
        await queryRunner.query(`DROP TABLE "recruiting_scorecards"`);
        await queryRunner.query(`DROP INDEX "IDX_a1ce15f3420232b32ede42fdcc"`);
        await queryRunner.query(`DROP INDEX "IDX_ab8483b0128d5ac386c78d8f70"`);
        await queryRunner.query(`DROP INDEX "IDX_b655b28530b092f69cc406adb6"`);
        await queryRunner.query(`DROP INDEX "IDX_9a796da754d67590d2efd91ea9"`);
        await queryRunner.query(`DROP INDEX "IDX_0dd73fdce6baa0a78d14f1741e"`);
        await queryRunner.query(`DROP TABLE "recruiting_applications"`);
        await queryRunner.query(`DROP INDEX "IDX_9449471c580922f5bd37190f46"`);
        await queryRunner.query(`DROP INDEX "IDX_96d4badc29680ef2b9f4df4ed6"`);
        await queryRunner.query(`DROP TABLE "recruiting_openings"`);
        await queryRunner.query(`DROP INDEX "IDX_2dc06106c31ef0d23eb29c1a56"`);
        await queryRunner.query(`DROP INDEX "IDX_78b5a927f5a10c28b1d4405b9f"`);
        await queryRunner.query(`DROP TABLE "recruiting_settings"`);
    }

}
