import { MigrationInterface, QueryRunner } from "typeorm";

export class Support1793879866461 implements MigrationInterface {
    name = 'Support1793879866461'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "support_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "aiEmployeeId" character varying, "nextTicketNumber" integer NOT NULL DEFAULT '1', "workingLanguage" character varying NOT NULL DEFAULT 'English', "slaEnabled" boolean NOT NULL DEFAULT true, "ratingsEnabled" boolean NOT NULL DEFAULT false, "autoCloseDays" integer NOT NULL DEFAULT '7', "autoSolveDays" integer NOT NULL DEFAULT '5', "insightsAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "aiInstructions" text NOT NULL DEFAULT '', "aiDisclosure" text, "topicsJson" text, "slaJson" text, "businessHoursJson" text, "insightsJson" text, CONSTRAINT "PK_d0fc942e9152aa165b56a2bd083" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5ce72101c56e73c64ca6f8b9a4" ON "support_settings" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "support_inboxes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "accountId" character varying NOT NULL, "name" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'active', "fromAddress" character varying NOT NULL DEFAULT '', "fromName" character varying NOT NULL DEFAULT '', "aiMode" character varying NOT NULL DEFAULT 'draft', "aiEmployeeId" character varying, "autoReplyDailyLimit" integer NOT NULL DEFAULT '100', "acknowledge" boolean NOT NULL DEFAULT false, "archiveOnSolve" boolean NOT NULL DEFAULT false, "watchFrom" TIMESTAMP WITH TIME ZONE NOT NULL, "importStatus" character varying NOT NULL DEFAULT 'none', "importedCount" integer NOT NULL DEFAULT '0', "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "addressesJson" text NOT NULL DEFAULT '[]', "aiInstructions" text NOT NULL DEFAULT '', "signature" text NOT NULL DEFAULT '', "acknowledgementBody" text, CONSTRAINT "PK_12e0a4ff9b0a8a8f6da1c59b1b7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_aa8a280934c5f8e2ce0df4a667" ON "support_inboxes" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a5042796d3a09f09ab055ce043" ON "support_inboxes" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "support_tickets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "number" integer NOT NULL, "inboxId" character varying, "accountId" character varying, "gmailThreadId" character varying, "status" character varying NOT NULL DEFAULT 'new', "actionable" boolean NOT NULL DEFAULT true, "priority" character varying NOT NULL DEFAULT 'normal', "priorityRank" integer NOT NULL DEFAULT '2', "prioritySource" character varying NOT NULL DEFAULT 'default', "topicKey" character varying, "topicSource" character varying NOT NULL DEFAULT 'default', "subject" character varying NOT NULL DEFAULT '', "requesterEmail" character varying NOT NULL DEFAULT '', "requesterName" character varying NOT NULL DEFAULT '', "matchedAddress" character varying NOT NULL DEFAULT '', "customerId" character varying, "contactId" character varying, "assigneeUserId" character varying, "assigneeEmployeeId" character varying, "draftReady" boolean NOT NULL DEFAULT false, "aiHandled" boolean NOT NULL DEFAULT false, "needsHuman" boolean NOT NULL DEFAULT false, "aiReplyCount" integer NOT NULL DEFAULT '0', "sentiment" character varying, "language" character varying NOT NULL DEFAULT '', "messageCount" integer NOT NULL DEFAULT '0', "reopenCount" integer NOT NULL DEFAULT '0', "lastActivityAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastCustomerMessageAt" TIMESTAMP WITH TIME ZONE, "lastAgentMessageAt" TIMESTAMP WITH TIME ZONE, "firstResponseDueAt" TIMESTAMP WITH TIME ZONE, "firstRespondedAt" TIMESTAMP WITH TIME ZONE, "responseDueAt" TIMESTAMP WITH TIME ZONE, "resolutionDueAt" TIMESTAMP WITH TIME ZONE, "slaDueAt" TIMESTAMP WITH TIME ZONE, "slaBreachedAt" TIMESTAMP WITH TIME ZONE, "solvedAt" TIMESTAMP WITH TIME ZONE, "closedAt" TIMESTAMP WITH TIME ZONE, "snoozedUntil" TIMESTAMP WITH TIME ZONE, "mergedIntoId" character varying, "ratingScore" integer, "ratingAt" TIMESTAMP WITH TIME ZONE, "ratingDueAt" TIMESTAMP WITH TIME ZONE, "ratingRequestedAt" TIMESTAMP WITH TIME ZONE, "ratingTokenHash" character varying, "source" character varying NOT NULL DEFAULT 'email', "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "ccJson" text NOT NULL DEFAULT '[]', "tagsJson" text NOT NULL DEFAULT '[]', "aiSummary" text NOT NULL DEFAULT '', "aiNextStep" text NOT NULL DEFAULT '', "aiHandoffReason" text NOT NULL DEFAULT '', "spamReason" text NOT NULL DEFAULT '', "ratingComment" text NOT NULL DEFAULT '', CONSTRAINT "PK_942e8d8f5df86100471d2324643" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d82debc46c7a29c2dd7523d49f" ON "support_tickets" ("ratingDueAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_9c653d42ec6be27dbbaa4e5860" ON "support_tickets" ("status", "solvedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7e7704f3c7246c0dcc1ef53b0b" ON "support_tickets" ("status", "snoozedUntil") `);
        await queryRunner.query(`CREATE INDEX "IDX_6b1e6cd50b5436c4d599078ee3" ON "support_tickets" ("slaDueAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5dc22e19614d787245d6c30061" ON "support_tickets" ("inboxId", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fef7413a696f461ea3f0488026" ON "support_tickets" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_18a48546e06dc8f2a2ce53b317" ON "support_tickets" ("companyId", "requesterEmail", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_c30120d121f2737b8ea14aec9f" ON "support_tickets" ("companyId", "slaDueAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_64926470a92bb70fba1c33ab03" ON "support_tickets" ("companyId", "priorityRank", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f7d23cf1c7db47a8defba1c1ae" ON "support_tickets" ("companyId", "aiHandled", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7868cbc4744fe07f592e15a5f4" ON "support_tickets" ("companyId", "draftReady", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_47710769cfec4fe5aa613666c7" ON "support_tickets" ("companyId", "assigneeUserId", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_7c180a386bb2ec5cc91e23c81a" ON "support_tickets" ("companyId", "status", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8aaba1479fa98c99becb84473b" ON "support_tickets" ("companyId", "actionable", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_18760be236ea131e29df6459f1" ON "support_tickets" ("companyId", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_be95407c6ddbcb95b3f8ab066e" ON "support_tickets" ("accountId", "gmailThreadId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_92cfa353221c9d8c885b5c6cca" ON "support_tickets" ("companyId", "number") `);
        await queryRunner.query(`CREATE TABLE "support_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "ticketId" character varying NOT NULL, "kind" character varying NOT NULL, "accountId" character varying, "gmailMessageId" character varying, "automatedKind" character varying NOT NULL DEFAULT '', "messageIdHeader" character varying NOT NULL DEFAULT '', "inReplyToHeader" character varying NOT NULL DEFAULT '', "fromName" character varying NOT NULL DEFAULT '', "fromEmail" character varying NOT NULL DEFAULT '', "subject" character varying NOT NULL DEFAULT '', "authorUserId" character varying, "authorEmployeeId" character varying, "sentByAi" boolean NOT NULL DEFAULT false, "draftId" character varying, "sentAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "toEmails" text NOT NULL DEFAULT '', "ccEmails" text NOT NULL DEFAULT '', "referencesHeader" text NOT NULL DEFAULT '', "bodyText" text NOT NULL DEFAULT '', "bodyHtml" text NOT NULL DEFAULT '', "cleanText" text NOT NULL DEFAULT '', "attachmentsJson" text NOT NULL DEFAULT '[]', "citationsJson" text NOT NULL DEFAULT '[]', CONSTRAINT "PK_2aa37479e71ef29cbf4dba2b1a2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_886314c80f5453fe842c406f0d" ON "support_messages" ("companyId", "messageIdHeader") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c5053aa6d9ae5f13c009788669" ON "support_messages" ("accountId", "gmailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5cde2061bafe092a39e3e4f494" ON "support_messages" ("ticketId", "sentAt", "id") `);
        await queryRunner.query(`CREATE TABLE "support_drafts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "ticketId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'ready', "employeeId" character varying, "basedOnMessageId" character varying, "answerable" boolean NOT NULL DEFAULT false, "confidence" character varying NOT NULL DEFAULT 'low', "injectionDetected" boolean NOT NULL DEFAULT false, "editedBeforeSend" boolean NOT NULL DEFAULT false, "topicKey" character varying, "sentMessageId" character varying, "decidedByUserId" character varying, "decidedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "body" text NOT NULL DEFAULT '', "translation" text NOT NULL DEFAULT '', "citationsJson" text NOT NULL DEFAULT '[]', "note" text NOT NULL DEFAULT '', "holdReasonsJson" text NOT NULL DEFAULT '[]', "gapQuestion" text NOT NULL DEFAULT '', CONSTRAINT "PK_e95f55b21d4539ae03ac26bcf36" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dd437e2c9c647535f69310d18b" ON "support_drafts" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_b4bed8ea8f9beb124defd020c5" ON "support_drafts" ("ticketId", "status") `);
        await queryRunner.query(`CREATE TABLE "support_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "ticketId" character varying NOT NULL, "kind" character varying NOT NULL, "actorKind" character varying NOT NULL, "actorUserId" character varying, "actorEmployeeId" character varying, "actorName" character varying NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "dataJson" text NOT NULL DEFAULT '{}', CONSTRAINT "PK_b59f21a2ebbfb9619189206eed9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f52b563e00df4535e6343d87f5" ON "support_events" ("companyId", "kind", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_abacf57eb43624b1221ffd95cf" ON "support_events" ("ticketId", "createdAt", "id") `);
        await queryRunner.query(`CREATE TABLE "support_articles" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'draft', "title" character varying NOT NULL, "topicKey" character varying, "sourceTicketId" character varying, "createdByUserId" character varying, "createdByEmployeeId" character varying, "citedCount" integer NOT NULL DEFAULT '0', "lastCitedAt" TIMESTAMP WITH TIME ZONE, "publishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "body" text NOT NULL DEFAULT '', CONSTRAINT "PK_b363703329e978dd173af57ebad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ea1c1946013a705a048718ed45" ON "support_articles" ("companyId", "status", "updatedAt", "id") `);
        await queryRunner.query(`CREATE TABLE "support_saved_replies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "usageCount" integer NOT NULL DEFAULT '0', "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "body" text NOT NULL DEFAULT '', CONSTRAINT "PK_87e1ab1800b2137eb72b4cc6ab8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9084ba2603fb5619e6f6322af3" ON "support_saved_replies" ("companyId", "name") `);
        await queryRunner.query(`CREATE TABLE "support_jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "kind" character varying NOT NULL, "targetId" character varying NOT NULL, "ticketId" character varying, "status" character varying NOT NULL DEFAULT 'queued', "attempts" integer NOT NULL DEFAULT '0', "runAfter" TIMESTAMP WITH TIME ZONE NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE, "finishedAt" TIMESTAMP WITH TIME ZONE, "requestedByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "error" text NOT NULL DEFAULT '', CONSTRAINT "PK_7a4502dc336cd9cdaa51a9ea22b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9fa93237771fe632f9ee8ffddc" ON "support_jobs" ("ticketId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a926999a1ee450b76d74bcd2f" ON "support_jobs" ("companyId", "kind", "targetId") `);
        await queryRunner.query(`CREATE INDEX "IDX_64b7374050b6fdc1fa4c6dcc69" ON "support_jobs" ("status", "runAfter") `);
        await queryRunner.query(`CREATE TABLE "employee_support_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b56ada6f0f53aaba8c97156c345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04ed3f57ca8ffe6e711e2eb08b" ON "employee_support_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7d298590c365516e781def5e2a" ON "employee_support_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_7d298590c365516e781def5e2a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_04ed3f57ca8ffe6e711e2eb08b"`);
        await queryRunner.query(`DROP TABLE "employee_support_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_64b7374050b6fdc1fa4c6dcc69"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9a926999a1ee450b76d74bcd2f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9fa93237771fe632f9ee8ffddc"`);
        await queryRunner.query(`DROP TABLE "support_jobs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9084ba2603fb5619e6f6322af3"`);
        await queryRunner.query(`DROP TABLE "support_saved_replies"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ea1c1946013a705a048718ed45"`);
        await queryRunner.query(`DROP TABLE "support_articles"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_abacf57eb43624b1221ffd95cf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f52b563e00df4535e6343d87f5"`);
        await queryRunner.query(`DROP TABLE "support_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b4bed8ea8f9beb124defd020c5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dd437e2c9c647535f69310d18b"`);
        await queryRunner.query(`DROP TABLE "support_drafts"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5cde2061bafe092a39e3e4f494"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c5053aa6d9ae5f13c009788669"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_886314c80f5453fe842c406f0d"`);
        await queryRunner.query(`DROP TABLE "support_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_92cfa353221c9d8c885b5c6cca"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_be95407c6ddbcb95b3f8ab066e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_18760be236ea131e29df6459f1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8aaba1479fa98c99becb84473b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7c180a386bb2ec5cc91e23c81a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_47710769cfec4fe5aa613666c7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7868cbc4744fe07f592e15a5f4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f7d23cf1c7db47a8defba1c1ae"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_64926470a92bb70fba1c33ab03"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c30120d121f2737b8ea14aec9f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_18a48546e06dc8f2a2ce53b317"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fef7413a696f461ea3f0488026"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5dc22e19614d787245d6c30061"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6b1e6cd50b5436c4d599078ee3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7e7704f3c7246c0dcc1ef53b0b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9c653d42ec6be27dbbaa4e5860"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d82debc46c7a29c2dd7523d49f"`);
        await queryRunner.query(`DROP TABLE "support_tickets"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a5042796d3a09f09ab055ce043"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aa8a280934c5f8e2ce0df4a667"`);
        await queryRunner.query(`DROP TABLE "support_inboxes"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5ce72101c56e73c64ca6f8b9a4"`);
        await queryRunner.query(`DROP TABLE "support_settings"`);
    }

}
