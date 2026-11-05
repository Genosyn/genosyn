import { MigrationInterface, QueryRunner } from "typeorm";

export class Support1793879862945 implements MigrationInterface {
    name = 'Support1793879862945'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "support_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "aiEmployeeId" varchar, "nextTicketNumber" integer NOT NULL DEFAULT (1), "workingLanguage" varchar NOT NULL DEFAULT ('English'), "slaEnabled" boolean NOT NULL DEFAULT (1), "ratingsEnabled" boolean NOT NULL DEFAULT (0), "autoCloseDays" integer NOT NULL DEFAULT (7), "autoSolveDays" integer NOT NULL DEFAULT (5), "insightsAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "aiInstructions" text NOT NULL DEFAULT (''), "aiDisclosure" text, "topicsJson" text, "slaJson" text, "businessHoursJson" text, "insightsJson" text)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5ce72101c56e73c64ca6f8b9a4" ON "support_settings" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "support_inboxes" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "name" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('active'), "fromAddress" varchar NOT NULL DEFAULT (''), "fromName" varchar NOT NULL DEFAULT (''), "aiMode" varchar NOT NULL DEFAULT ('draft'), "aiEmployeeId" varchar, "autoReplyDailyLimit" integer NOT NULL DEFAULT (100), "acknowledge" boolean NOT NULL DEFAULT (0), "archiveOnSolve" boolean NOT NULL DEFAULT (0), "watchFrom" datetime NOT NULL, "importStatus" varchar NOT NULL DEFAULT ('none'), "importedCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "addressesJson" text NOT NULL DEFAULT ('[]'), "aiInstructions" text NOT NULL DEFAULT (''), "signature" text NOT NULL DEFAULT (''), "acknowledgementBody" text)`);
        await queryRunner.query(`CREATE INDEX "IDX_aa8a280934c5f8e2ce0df4a667" ON "support_inboxes" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a5042796d3a09f09ab055ce043" ON "support_inboxes" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "support_tickets" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "number" integer NOT NULL, "inboxId" varchar, "accountId" varchar, "gmailThreadId" varchar, "status" varchar NOT NULL DEFAULT ('new'), "actionable" boolean NOT NULL DEFAULT (1), "priority" varchar NOT NULL DEFAULT ('normal'), "priorityRank" integer NOT NULL DEFAULT (2), "prioritySource" varchar NOT NULL DEFAULT ('default'), "topicKey" varchar, "topicSource" varchar NOT NULL DEFAULT ('default'), "subject" varchar NOT NULL DEFAULT (''), "requesterEmail" varchar NOT NULL DEFAULT (''), "requesterName" varchar NOT NULL DEFAULT (''), "matchedAddress" varchar NOT NULL DEFAULT (''), "customerId" varchar, "contactId" varchar, "assigneeUserId" varchar, "assigneeEmployeeId" varchar, "draftReady" boolean NOT NULL DEFAULT (0), "aiHandled" boolean NOT NULL DEFAULT (0), "needsHuman" boolean NOT NULL DEFAULT (0), "aiReplyCount" integer NOT NULL DEFAULT (0), "sentiment" varchar, "language" varchar NOT NULL DEFAULT (''), "messageCount" integer NOT NULL DEFAULT (0), "reopenCount" integer NOT NULL DEFAULT (0), "lastActivityAt" datetime NOT NULL, "lastCustomerMessageAt" datetime, "lastAgentMessageAt" datetime, "firstResponseDueAt" datetime, "firstRespondedAt" datetime, "responseDueAt" datetime, "resolutionDueAt" datetime, "slaDueAt" datetime, "slaBreachedAt" datetime, "solvedAt" datetime, "closedAt" datetime, "snoozedUntil" datetime, "mergedIntoId" varchar, "ratingScore" integer, "ratingAt" datetime, "ratingDueAt" datetime, "ratingRequestedAt" datetime, "ratingTokenHash" varchar, "source" varchar NOT NULL DEFAULT ('email'), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "ccJson" text NOT NULL DEFAULT ('[]'), "tagsJson" text NOT NULL DEFAULT ('[]'), "aiSummary" text NOT NULL DEFAULT (''), "aiNextStep" text NOT NULL DEFAULT (''), "aiHandoffReason" text NOT NULL DEFAULT (''), "spamReason" text NOT NULL DEFAULT (''), "ratingComment" text NOT NULL DEFAULT (''))`);
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
        await queryRunner.query(`CREATE TABLE "support_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "ticketId" varchar NOT NULL, "kind" varchar NOT NULL, "accountId" varchar, "gmailMessageId" varchar, "automatedKind" varchar NOT NULL DEFAULT (''), "messageIdHeader" varchar NOT NULL DEFAULT (''), "inReplyToHeader" varchar NOT NULL DEFAULT (''), "fromName" varchar NOT NULL DEFAULT (''), "fromEmail" varchar NOT NULL DEFAULT (''), "subject" varchar NOT NULL DEFAULT (''), "authorUserId" varchar, "authorEmployeeId" varchar, "sentByAi" boolean NOT NULL DEFAULT (0), "draftId" varchar, "sentAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "toEmails" text NOT NULL DEFAULT (''), "ccEmails" text NOT NULL DEFAULT (''), "referencesHeader" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "bodyHtml" text NOT NULL DEFAULT (''), "cleanText" text NOT NULL DEFAULT (''), "attachmentsJson" text NOT NULL DEFAULT ('[]'), "citationsJson" text NOT NULL DEFAULT ('[]'))`);
        await queryRunner.query(`CREATE INDEX "IDX_886314c80f5453fe842c406f0d" ON "support_messages" ("companyId", "messageIdHeader") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c5053aa6d9ae5f13c009788669" ON "support_messages" ("accountId", "gmailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5cde2061bafe092a39e3e4f494" ON "support_messages" ("ticketId", "sentAt", "id") `);
        await queryRunner.query(`CREATE TABLE "support_drafts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "ticketId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('ready'), "employeeId" varchar, "basedOnMessageId" varchar, "answerable" boolean NOT NULL DEFAULT (0), "confidence" varchar NOT NULL DEFAULT ('low'), "injectionDetected" boolean NOT NULL DEFAULT (0), "editedBeforeSend" boolean NOT NULL DEFAULT (0), "topicKey" varchar, "sentMessageId" varchar, "decidedByUserId" varchar, "decidedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "body" text NOT NULL DEFAULT (''), "translation" text NOT NULL DEFAULT (''), "citationsJson" text NOT NULL DEFAULT ('[]'), "note" text NOT NULL DEFAULT (''), "holdReasonsJson" text NOT NULL DEFAULT ('[]'), "gapQuestion" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_dd437e2c9c647535f69310d18b" ON "support_drafts" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_b4bed8ea8f9beb124defd020c5" ON "support_drafts" ("ticketId", "status") `);
        await queryRunner.query(`CREATE TABLE "support_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "ticketId" varchar NOT NULL, "kind" varchar NOT NULL, "actorKind" varchar NOT NULL, "actorUserId" varchar, "actorEmployeeId" varchar, "actorName" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "dataJson" text NOT NULL DEFAULT ('{}'))`);
        await queryRunner.query(`CREATE INDEX "IDX_f52b563e00df4535e6343d87f5" ON "support_events" ("companyId", "kind", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_abacf57eb43624b1221ffd95cf" ON "support_events" ("ticketId", "createdAt", "id") `);
        await queryRunner.query(`CREATE TABLE "support_articles" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('draft'), "title" varchar NOT NULL, "topicKey" varchar, "sourceTicketId" varchar, "createdByUserId" varchar, "createdByEmployeeId" varchar, "citedCount" integer NOT NULL DEFAULT (0), "lastCitedAt" datetime, "publishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "body" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_ea1c1946013a705a048718ed45" ON "support_articles" ("companyId", "status", "updatedAt", "id") `);
        await queryRunner.query(`CREATE TABLE "support_saved_replies" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "usageCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "body" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_9084ba2603fb5619e6f6322af3" ON "support_saved_replies" ("companyId", "name") `);
        await queryRunner.query(`CREATE TABLE "support_jobs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "targetId" varchar NOT NULL, "ticketId" varchar, "status" varchar NOT NULL DEFAULT ('queued'), "attempts" integer NOT NULL DEFAULT (0), "runAfter" datetime NOT NULL, "startedAt" datetime, "finishedAt" datetime, "requestedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "error" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_9fa93237771fe632f9ee8ffddc" ON "support_jobs" ("ticketId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a926999a1ee450b76d74bcd2f" ON "support_jobs" ("companyId", "kind", "targetId") `);
        await queryRunner.query(`CREATE INDEX "IDX_64b7374050b6fdc1fa4c6dcc69" ON "support_jobs" ("status", "runAfter") `);
        await queryRunner.query(`CREATE TABLE "employee_support_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04ed3f57ca8ffe6e711e2eb08b" ON "employee_support_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7d298590c365516e781def5e2a" ON "employee_support_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7d298590c365516e781def5e2a"`);
        await queryRunner.query(`DROP INDEX "IDX_04ed3f57ca8ffe6e711e2eb08b"`);
        await queryRunner.query(`DROP TABLE "employee_support_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_64b7374050b6fdc1fa4c6dcc69"`);
        await queryRunner.query(`DROP INDEX "IDX_9a926999a1ee450b76d74bcd2f"`);
        await queryRunner.query(`DROP INDEX "IDX_9fa93237771fe632f9ee8ffddc"`);
        await queryRunner.query(`DROP TABLE "support_jobs"`);
        await queryRunner.query(`DROP INDEX "IDX_9084ba2603fb5619e6f6322af3"`);
        await queryRunner.query(`DROP TABLE "support_saved_replies"`);
        await queryRunner.query(`DROP INDEX "IDX_ea1c1946013a705a048718ed45"`);
        await queryRunner.query(`DROP TABLE "support_articles"`);
        await queryRunner.query(`DROP INDEX "IDX_abacf57eb43624b1221ffd95cf"`);
        await queryRunner.query(`DROP INDEX "IDX_f52b563e00df4535e6343d87f5"`);
        await queryRunner.query(`DROP TABLE "support_events"`);
        await queryRunner.query(`DROP INDEX "IDX_b4bed8ea8f9beb124defd020c5"`);
        await queryRunner.query(`DROP INDEX "IDX_dd437e2c9c647535f69310d18b"`);
        await queryRunner.query(`DROP TABLE "support_drafts"`);
        await queryRunner.query(`DROP INDEX "IDX_5cde2061bafe092a39e3e4f494"`);
        await queryRunner.query(`DROP INDEX "IDX_c5053aa6d9ae5f13c009788669"`);
        await queryRunner.query(`DROP INDEX "IDX_886314c80f5453fe842c406f0d"`);
        await queryRunner.query(`DROP TABLE "support_messages"`);
        await queryRunner.query(`DROP INDEX "IDX_92cfa353221c9d8c885b5c6cca"`);
        await queryRunner.query(`DROP INDEX "IDX_be95407c6ddbcb95b3f8ab066e"`);
        await queryRunner.query(`DROP INDEX "IDX_18760be236ea131e29df6459f1"`);
        await queryRunner.query(`DROP INDEX "IDX_8aaba1479fa98c99becb84473b"`);
        await queryRunner.query(`DROP INDEX "IDX_7c180a386bb2ec5cc91e23c81a"`);
        await queryRunner.query(`DROP INDEX "IDX_47710769cfec4fe5aa613666c7"`);
        await queryRunner.query(`DROP INDEX "IDX_7868cbc4744fe07f592e15a5f4"`);
        await queryRunner.query(`DROP INDEX "IDX_f7d23cf1c7db47a8defba1c1ae"`);
        await queryRunner.query(`DROP INDEX "IDX_64926470a92bb70fba1c33ab03"`);
        await queryRunner.query(`DROP INDEX "IDX_c30120d121f2737b8ea14aec9f"`);
        await queryRunner.query(`DROP INDEX "IDX_18a48546e06dc8f2a2ce53b317"`);
        await queryRunner.query(`DROP INDEX "IDX_fef7413a696f461ea3f0488026"`);
        await queryRunner.query(`DROP INDEX "IDX_5dc22e19614d787245d6c30061"`);
        await queryRunner.query(`DROP INDEX "IDX_6b1e6cd50b5436c4d599078ee3"`);
        await queryRunner.query(`DROP INDEX "IDX_7e7704f3c7246c0dcc1ef53b0b"`);
        await queryRunner.query(`DROP INDEX "IDX_9c653d42ec6be27dbbaa4e5860"`);
        await queryRunner.query(`DROP INDEX "IDX_d82debc46c7a29c2dd7523d49f"`);
        await queryRunner.query(`DROP TABLE "support_tickets"`);
        await queryRunner.query(`DROP INDEX "IDX_a5042796d3a09f09ab055ce043"`);
        await queryRunner.query(`DROP INDEX "IDX_aa8a280934c5f8e2ce0df4a667"`);
        await queryRunner.query(`DROP TABLE "support_inboxes"`);
        await queryRunner.query(`DROP INDEX "IDX_5ce72101c56e73c64ca6f8b9a4"`);
        await queryRunner.query(`DROP TABLE "support_settings"`);
    }

}
