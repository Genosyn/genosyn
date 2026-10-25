import { MigrationInterface, QueryRunner } from "typeorm";

export class DataRooms1792931846496 implements MigrationInterface {
    name = 'DataRooms1792931846496'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "data_rooms" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "purpose" character varying NOT NULL DEFAULT 'other', "status" character varying NOT NULL DEFAULT 'open', "description" text NOT NULL DEFAULT '', "welcomeMessage" text NOT NULL DEFAULT '', "allowDownloads" boolean NOT NULL DEFAULT false, "watermark" boolean NOT NULL DEFAULT true, "requireTerms" boolean NOT NULL DEFAULT false, "termsText" text NOT NULL DEFAULT '', "aiEmployeeId" character varying, "aiAnswerMode" character varying NOT NULL DEFAULT 'draft', "readinessJson" text, "readinessAt" TIMESTAMP WITH TIME ZONE, "insightsJson" text, "insightsAt" TIMESTAMP WITH TIME ZONE, "lastGuestActivityAt" TIMESTAMP WITH TIME ZONE, "closedAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_09dd3ce72c621d7bf68b4bda781" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c7bbbb1580fa693588c2677eb5" ON "data_rooms" ("companyId", "updatedAt") `);
        await queryRunner.query(`CREATE TABLE "data_room_folders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "roomId" character varying NOT NULL, "name" character varying NOT NULL, "position" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ad4693caa033d63aab85070981c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6f56c552f8ca6f933f9289e385" ON "data_room_folders" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ca1c1bad74e1f37f7a2e307663" ON "data_room_folders" ("roomId", "position") `);
        await queryRunner.query(`CREATE TABLE "data_room_documents" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "roomId" character varying NOT NULL, "folderId" character varying, "title" character varying NOT NULL, "filename" character varying NOT NULL, "mimeType" character varying NOT NULL DEFAULT 'application/octet-stream', "sizeBytes" integer NOT NULL DEFAULT '0', "storageKey" character varying NOT NULL, "sha256" character varying NOT NULL DEFAULT '', "position" integer NOT NULL DEFAULT '0', "pageCount" integer NOT NULL DEFAULT '0', "textStatus" character varying NOT NULL DEFAULT 'pending', "textChars" integer NOT NULL DEFAULT '0', "briefJson" text, "briefAt" TIMESTAMP WITH TIME ZONE, "sourceResourceId" character varying, "uploadedByUserId" character varying, "uploadedByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "text" text NOT NULL DEFAULT '', CONSTRAINT "PK_d5b79e63f3886b6e86d8281ec20" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6d3724b1640ebacdad0fc20f0e" ON "data_room_documents" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_159fdfd781f2e14d2ec005f9b8" ON "data_room_documents" ("roomId", "folderId", "position") `);
        await queryRunner.query(`CREATE TABLE "data_room_guests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "roomId" character varying NOT NULL, "name" character varying NOT NULL, "email" character varying NOT NULL, "organization" character varying NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'active', "folderIdsJson" text NOT NULL DEFAULT '[]', "expiresAt" TIMESTAMP WITH TIME ZONE, "tokenHash" character varying NOT NULL, "tokenEncrypted" text NOT NULL, "termsAcceptedAt" TIMESTAMP WITH TIME ZONE, "termsAcceptedName" character varying NOT NULL DEFAULT '', "termsSha256" character varying NOT NULL DEFAULT '', "termsAcceptedIp" character varying NOT NULL DEFAULT '', "firstViewedAt" TIMESTAMP WITH TIME ZONE, "lastViewedAt" TIMESTAMP WITH TIME ZONE, "visitCount" integer NOT NULL DEFAULT '0', "totalSeconds" integer NOT NULL DEFAULT '0', "inviteStatus" character varying NOT NULL DEFAULT 'none', "inviteError" text NOT NULL DEFAULT '', "inviteSentAt" TIMESTAMP WITH TIME ZONE, "invitedByUserId" character varying, "invitedByEmployeeId" character varying, "revokedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_686c79294a15cff91ed53803a42" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5508be1ab21ea0619ee765282a" ON "data_room_guests" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7b1dae6a130b13550a049dd636" ON "data_room_guests" ("tokenHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_af8fea895c83a1e8602c627411" ON "data_room_guests" ("roomId", "email") `);
        await queryRunner.query(`CREATE TABLE "data_room_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "roomId" character varying NOT NULL, "guestId" character varying NOT NULL, "documentId" character varying, "kind" character varying NOT NULL, "seconds" integer NOT NULL DEFAULT '0', "ipAddress" character varying NOT NULL DEFAULT '', "userAgent" character varying NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_395430414e14c87ab45a66efc65" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_414e5513ae375da26bd4976904" ON "data_room_events" ("documentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e07491aeea4155d9c6fb085448" ON "data_room_events" ("guestId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5565fa3180a2bd6681c308d699" ON "data_room_events" ("roomId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "data_room_questions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "roomId" character varying NOT NULL, "guestId" character varying NOT NULL, "documentId" character varying, "body" text NOT NULL, "status" character varying NOT NULL DEFAULT 'open', "answer" text NOT NULL DEFAULT '', "citationsJson" text NOT NULL DEFAULT '[]', "answeredByUserId" character varying, "answeredByEmployeeId" character varying, "answeredAt" TIMESTAMP WITH TIME ZONE, "draftAnswer" text NOT NULL DEFAULT '', "draftCitationsJson" text NOT NULL DEFAULT '[]', "draftNote" text NOT NULL DEFAULT '', "draftByEmployeeId" character varying, "draftAt" TIMESTAMP WITH TIME ZONE, "injectionFlag" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2e8e1ad9c3e2be4d1c869a30bb3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6a8187f00faf62fa1a7efe6df9" ON "data_room_questions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c7e8928a525d3498e933f218f0" ON "data_room_questions" ("guestId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_49668653e3a1bbf3bfe35dfc7d" ON "data_room_questions" ("roomId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "data_room_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "roomId" character varying NOT NULL, "kind" character varying NOT NULL, "targetId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'queued', "attempts" integer NOT NULL DEFAULT '0', "runAfter" TIMESTAMP WITH TIME ZONE NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE, "finishedAt" TIMESTAMP WITH TIME ZONE, "error" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8cb4abd1a61c5f858ecd6c57fd5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cfdd778f3f2e185cbf785fc145" ON "data_room_jobs" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0ba46424833762c2ed9168e4fa" ON "data_room_jobs" ("roomId", "kind", "targetId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b7a13f00c8f5ff46396cf19ca0" ON "data_room_jobs" ("status", "runAfter") `);
        await queryRunner.query(`CREATE TABLE "employee_data_room_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c0706dad6b308a68eeb44c1f57e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b72c36bd9770fa96d254716083" ON "employee_data_room_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_21e5fe1f8b0d1f9ce0100f029a" ON "employee_data_room_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_21e5fe1f8b0d1f9ce0100f029a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b72c36bd9770fa96d254716083"`);
        await queryRunner.query(`DROP TABLE "employee_data_room_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b7a13f00c8f5ff46396cf19ca0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0ba46424833762c2ed9168e4fa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cfdd778f3f2e185cbf785fc145"`);
        await queryRunner.query(`DROP TABLE "data_room_jobs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_49668653e3a1bbf3bfe35dfc7d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c7e8928a525d3498e933f218f0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6a8187f00faf62fa1a7efe6df9"`);
        await queryRunner.query(`DROP TABLE "data_room_questions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5565fa3180a2bd6681c308d699"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e07491aeea4155d9c6fb085448"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_414e5513ae375da26bd4976904"`);
        await queryRunner.query(`DROP TABLE "data_room_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_af8fea895c83a1e8602c627411"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7b1dae6a130b13550a049dd636"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5508be1ab21ea0619ee765282a"`);
        await queryRunner.query(`DROP TABLE "data_room_guests"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_159fdfd781f2e14d2ec005f9b8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6d3724b1640ebacdad0fc20f0e"`);
        await queryRunner.query(`DROP TABLE "data_room_documents"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ca1c1bad74e1f37f7a2e307663"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6f56c552f8ca6f933f9289e385"`);
        await queryRunner.query(`DROP TABLE "data_room_folders"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c7bbbb1580fa693588c2677eb5"`);
        await queryRunner.query(`DROP TABLE "data_rooms"`);
    }

}
