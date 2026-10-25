import { MigrationInterface, QueryRunner } from "typeorm";

export class DataRooms1792926197477 implements MigrationInterface {
    name = 'DataRooms1792926197477'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "data_rooms" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "purpose" varchar NOT NULL DEFAULT ('other'), "status" varchar NOT NULL DEFAULT ('open'), "description" text NOT NULL DEFAULT (''), "welcomeMessage" text NOT NULL DEFAULT (''), "allowDownloads" boolean NOT NULL DEFAULT (0), "watermark" boolean NOT NULL DEFAULT (1), "requireTerms" boolean NOT NULL DEFAULT (0), "termsText" text NOT NULL DEFAULT (''), "aiEmployeeId" varchar, "aiAnswerMode" varchar NOT NULL DEFAULT ('draft'), "readinessJson" text, "readinessAt" datetime, "insightsJson" text, "insightsAt" datetime, "lastGuestActivityAt" datetime, "closedAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_c7bbbb1580fa693588c2677eb5" ON "data_rooms" ("companyId", "updatedAt") `);
        await queryRunner.query(`CREATE TABLE "data_room_folders" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "roomId" varchar NOT NULL, "name" varchar NOT NULL, "position" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_6f56c552f8ca6f933f9289e385" ON "data_room_folders" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ca1c1bad74e1f37f7a2e307663" ON "data_room_folders" ("roomId", "position") `);
        await queryRunner.query(`CREATE TABLE "data_room_documents" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "roomId" varchar NOT NULL, "folderId" varchar, "title" varchar NOT NULL, "filename" varchar NOT NULL, "mimeType" varchar NOT NULL DEFAULT ('application/octet-stream'), "sizeBytes" integer NOT NULL DEFAULT (0), "storageKey" varchar NOT NULL, "sha256" varchar NOT NULL DEFAULT (''), "position" integer NOT NULL DEFAULT (0), "pageCount" integer NOT NULL DEFAULT (0), "textStatus" varchar NOT NULL DEFAULT ('pending'), "textChars" integer NOT NULL DEFAULT (0), "briefJson" text, "briefAt" datetime, "sourceResourceId" varchar, "uploadedByUserId" varchar, "uploadedByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "text" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_6d3724b1640ebacdad0fc20f0e" ON "data_room_documents" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_159fdfd781f2e14d2ec005f9b8" ON "data_room_documents" ("roomId", "folderId", "position") `);
        await queryRunner.query(`CREATE TABLE "data_room_guests" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "roomId" varchar NOT NULL, "name" varchar NOT NULL, "email" varchar NOT NULL, "organization" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('active'), "folderIdsJson" text NOT NULL DEFAULT ('[]'), "expiresAt" datetime, "tokenHash" varchar NOT NULL, "tokenEncrypted" text NOT NULL, "termsAcceptedAt" datetime, "termsAcceptedName" varchar NOT NULL DEFAULT (''), "termsSha256" varchar NOT NULL DEFAULT (''), "termsAcceptedIp" varchar NOT NULL DEFAULT (''), "firstViewedAt" datetime, "lastViewedAt" datetime, "visitCount" integer NOT NULL DEFAULT (0), "totalSeconds" integer NOT NULL DEFAULT (0), "inviteStatus" varchar NOT NULL DEFAULT ('none'), "inviteError" text NOT NULL DEFAULT (''), "inviteSentAt" datetime, "invitedByUserId" varchar, "invitedByEmployeeId" varchar, "revokedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_5508be1ab21ea0619ee765282a" ON "data_room_guests" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7b1dae6a130b13550a049dd636" ON "data_room_guests" ("tokenHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_af8fea895c83a1e8602c627411" ON "data_room_guests" ("roomId", "email") `);
        await queryRunner.query(`CREATE TABLE "data_room_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "roomId" varchar NOT NULL, "guestId" varchar NOT NULL, "documentId" varchar, "kind" varchar NOT NULL, "seconds" integer NOT NULL DEFAULT (0), "ipAddress" varchar NOT NULL DEFAULT (''), "userAgent" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_414e5513ae375da26bd4976904" ON "data_room_events" ("documentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e07491aeea4155d9c6fb085448" ON "data_room_events" ("guestId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5565fa3180a2bd6681c308d699" ON "data_room_events" ("roomId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "data_room_questions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "roomId" varchar NOT NULL, "guestId" varchar NOT NULL, "documentId" varchar, "body" text NOT NULL, "status" varchar NOT NULL DEFAULT ('open'), "answer" text NOT NULL DEFAULT (''), "citationsJson" text NOT NULL DEFAULT ('[]'), "answeredByUserId" varchar, "answeredByEmployeeId" varchar, "answeredAt" datetime, "draftAnswer" text NOT NULL DEFAULT (''), "draftCitationsJson" text NOT NULL DEFAULT ('[]'), "draftNote" text NOT NULL DEFAULT (''), "draftByEmployeeId" varchar, "draftAt" datetime, "injectionFlag" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_6a8187f00faf62fa1a7efe6df9" ON "data_room_questions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c7e8928a525d3498e933f218f0" ON "data_room_questions" ("guestId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_49668653e3a1bbf3bfe35dfc7d" ON "data_room_questions" ("roomId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "data_room_jobs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "roomId" varchar NOT NULL, "kind" varchar NOT NULL, "targetId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "attempts" integer NOT NULL DEFAULT (0), "runAfter" datetime NOT NULL, "startedAt" datetime, "finishedAt" datetime, "error" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_cfdd778f3f2e185cbf785fc145" ON "data_room_jobs" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0ba46424833762c2ed9168e4fa" ON "data_room_jobs" ("roomId", "kind", "targetId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b7a13f00c8f5ff46396cf19ca0" ON "data_room_jobs" ("status", "runAfter") `);
        await queryRunner.query(`CREATE TABLE "employee_data_room_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b72c36bd9770fa96d254716083" ON "employee_data_room_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_21e5fe1f8b0d1f9ce0100f029a" ON "employee_data_room_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_21e5fe1f8b0d1f9ce0100f029a"`);
        await queryRunner.query(`DROP INDEX "IDX_b72c36bd9770fa96d254716083"`);
        await queryRunner.query(`DROP TABLE "employee_data_room_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_b7a13f00c8f5ff46396cf19ca0"`);
        await queryRunner.query(`DROP INDEX "IDX_0ba46424833762c2ed9168e4fa"`);
        await queryRunner.query(`DROP INDEX "IDX_cfdd778f3f2e185cbf785fc145"`);
        await queryRunner.query(`DROP TABLE "data_room_jobs"`);
        await queryRunner.query(`DROP INDEX "IDX_49668653e3a1bbf3bfe35dfc7d"`);
        await queryRunner.query(`DROP INDEX "IDX_c7e8928a525d3498e933f218f0"`);
        await queryRunner.query(`DROP INDEX "IDX_6a8187f00faf62fa1a7efe6df9"`);
        await queryRunner.query(`DROP TABLE "data_room_questions"`);
        await queryRunner.query(`DROP INDEX "IDX_5565fa3180a2bd6681c308d699"`);
        await queryRunner.query(`DROP INDEX "IDX_e07491aeea4155d9c6fb085448"`);
        await queryRunner.query(`DROP INDEX "IDX_414e5513ae375da26bd4976904"`);
        await queryRunner.query(`DROP TABLE "data_room_events"`);
        await queryRunner.query(`DROP INDEX "IDX_af8fea895c83a1e8602c627411"`);
        await queryRunner.query(`DROP INDEX "IDX_7b1dae6a130b13550a049dd636"`);
        await queryRunner.query(`DROP INDEX "IDX_5508be1ab21ea0619ee765282a"`);
        await queryRunner.query(`DROP TABLE "data_room_guests"`);
        await queryRunner.query(`DROP INDEX "IDX_159fdfd781f2e14d2ec005f9b8"`);
        await queryRunner.query(`DROP INDEX "IDX_6d3724b1640ebacdad0fc20f0e"`);
        await queryRunner.query(`DROP TABLE "data_room_documents"`);
        await queryRunner.query(`DROP INDEX "IDX_ca1c1bad74e1f37f7a2e307663"`);
        await queryRunner.query(`DROP INDEX "IDX_6f56c552f8ca6f933f9289e385"`);
        await queryRunner.query(`DROP TABLE "data_room_folders"`);
        await queryRunner.query(`DROP INDEX "IDX_c7bbbb1580fa693588c2677eb5"`);
        await queryRunner.query(`DROP TABLE "data_rooms"`);
    }

}
