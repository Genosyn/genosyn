import { MigrationInterface, QueryRunner } from "typeorm";

export class GmailDocumentCaptureConcurrency1785185249263 implements MigrationInterface {
    name = 'GmailDocumentCaptureConcurrency1785185249263'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_c349795be800f0a51de41ca5af"`);
        await queryRunner.query(`DROP INDEX "IDX_01ecfb4195a7951a278c7c56dd"`);
        await queryRunner.query(`DROP INDEX "IDX_8e2f3e906b858cae25a64c27ce"`);
        await queryRunner.query(`DROP INDEX "IDX_3ecbf03e13486b18a729e2f392"`);
        await queryRunner.query(`DROP INDEX "IDX_e6e1e6843d68df6880c73fdb8b"`);
        await queryRunner.query(`DROP INDEX "IDX_725f4c1a7d34b794290b0ac08b"`);
        await queryRunner.query(`CREATE TABLE "temporary_revenue_documents" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "title" varchar NOT NULL, "notes" text NOT NULL DEFAULT (''), "dealId" varchar, "customerId" varchar, "partnershipId" varchar, "contactId" varchar, "attachmentId" varchar, "sourceMailMessageId" varchar, "externalUrl" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "sourceAttachmentIndex" integer, "sourceAttachmentHash" varchar NOT NULL DEFAULT (''), "sourceGmailMessageId" varchar NOT NULL DEFAULT (''), "sourceGmailThreadId" varchar NOT NULL DEFAULT (''), "sourceGmailAttachmentId" varchar NOT NULL DEFAULT (''), "captureDedupeHash" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_revenue_documents"("id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt", "sourceAttachmentIndex", "sourceAttachmentHash", "sourceGmailMessageId", "sourceGmailThreadId", "sourceGmailAttachmentId") SELECT "id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt", "sourceAttachmentIndex", "sourceAttachmentHash", "sourceGmailMessageId", "sourceGmailThreadId", "sourceGmailAttachmentId" FROM "revenue_documents"`);
        await queryRunner.query(`DROP TABLE "revenue_documents"`);
        await queryRunner.query(`ALTER TABLE "temporary_revenue_documents" RENAME TO "revenue_documents"`);
        await queryRunner.query(`CREATE INDEX "IDX_8e2f3e906b858cae25a64c27ce" ON "revenue_documents" ("companyId", "dealId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3ecbf03e13486b18a729e2f392" ON "revenue_documents" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e6e1e6843d68df6880c73fdb8b" ON "revenue_documents" ("companyId", "partnershipId") `);
        await queryRunner.query(`CREATE INDEX "IDX_725f4c1a7d34b794290b0ac08b" ON "revenue_documents" ("companyId", "contactId") `);
        await queryRunner.query(`DROP INDEX "IDX_14a36a18e0a6ebc09681150694"`);
        await queryRunner.query(`DROP INDEX "IDX_d1ce59fcc6aebe6406ca134b8e"`);
        await queryRunner.query(`DROP INDEX "IDX_0fcf2d66be620de74590adc735"`);
        await queryRunner.query(`CREATE TABLE "temporary_revenue_document_candidates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "mailMessageId" varchar NOT NULL, "attachmentIndex" integer NOT NULL, "filename" varchar NOT NULL, "mimeType" varchar NOT NULL, "sizeBytes" bigint NOT NULL DEFAULT (0), "contentHash" varchar NOT NULL DEFAULT (''), "proposedKind" varchar NOT NULL, "proposedResourceType" varchar, "proposedResourceId" varchar, "confidence" integer NOT NULL, "alternativesJson" text NOT NULL, "status" varchar NOT NULL, "revenueDocumentId" varchar, "reviewNote" text NOT NULL DEFAULT (''), "reviewedAt" datetime, "reviewedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "gmailMessageId" varchar NOT NULL DEFAULT (''), "gmailThreadId" varchar NOT NULL DEFAULT (''), "gmailAttachmentId" varchar NOT NULL DEFAULT (''), "processingAt" datetime, "processingToken" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_revenue_document_candidates"("id", "companyId", "mailMessageId", "attachmentIndex", "filename", "mimeType", "sizeBytes", "contentHash", "proposedKind", "proposedResourceType", "proposedResourceId", "confidence", "alternativesJson", "status", "revenueDocumentId", "reviewNote", "reviewedAt", "reviewedByUserId", "createdAt", "gmailMessageId", "gmailThreadId", "gmailAttachmentId") SELECT "id", "companyId", "mailMessageId", "attachmentIndex", "filename", "mimeType", "sizeBytes", "contentHash", "proposedKind", "proposedResourceType", "proposedResourceId", "confidence", "alternativesJson", "status", "revenueDocumentId", "reviewNote", "reviewedAt", "reviewedByUserId", "createdAt", "gmailMessageId", "gmailThreadId", "gmailAttachmentId" FROM "revenue_document_candidates"`);
        await queryRunner.query(`DROP TABLE "revenue_document_candidates"`);
        await queryRunner.query(`ALTER TABLE "temporary_revenue_document_candidates" RENAME TO "revenue_document_candidates"`);
        await queryRunner.query(`CREATE INDEX "IDX_14a36a18e0a6ebc09681150694" ON "revenue_document_candidates" ("companyId", "contentHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d1ce59fcc6aebe6406ca134b8e" ON "revenue_document_candidates" ("companyId", "mailMessageId", "attachmentIndex") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fcf2d66be620de74590adc735" ON "revenue_document_candidates" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_revenue_documents_capture_dedupe_hash" ON "revenue_documents" ("companyId", "captureDedupeHash") WHERE "captureDedupeHash" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_revenue_documents_gmail_attachment" ON "revenue_documents" ("companyId", "sourceGmailMessageId", "sourceGmailAttachmentId") WHERE "sourceGmailMessageId" <> '' AND "sourceGmailAttachmentId" <> ''`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_revenue_document_candidates_gmail_attachment" ON "revenue_document_candidates" ("companyId", "gmailMessageId", "gmailAttachmentId") WHERE "gmailMessageId" <> '' AND "gmailAttachmentId" <> ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "UQ_revenue_document_candidates_gmail_attachment"`);
        await queryRunner.query(`DROP INDEX "UQ_revenue_documents_gmail_attachment"`);
        await queryRunner.query(`DROP INDEX "UQ_revenue_documents_capture_dedupe_hash"`);
        await queryRunner.query(`DROP INDEX "IDX_0fcf2d66be620de74590adc735"`);
        await queryRunner.query(`DROP INDEX "IDX_d1ce59fcc6aebe6406ca134b8e"`);
        await queryRunner.query(`DROP INDEX "IDX_14a36a18e0a6ebc09681150694"`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" RENAME TO "temporary_revenue_document_candidates"`);
        await queryRunner.query(`CREATE TABLE "revenue_document_candidates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "mailMessageId" varchar NOT NULL, "attachmentIndex" integer NOT NULL, "filename" varchar NOT NULL, "mimeType" varchar NOT NULL, "sizeBytes" bigint NOT NULL DEFAULT (0), "contentHash" varchar NOT NULL DEFAULT (''), "proposedKind" varchar NOT NULL, "proposedResourceType" varchar, "proposedResourceId" varchar, "confidence" integer NOT NULL, "alternativesJson" text NOT NULL, "status" varchar NOT NULL, "revenueDocumentId" varchar, "reviewNote" text NOT NULL DEFAULT (''), "reviewedAt" datetime, "reviewedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "gmailMessageId" varchar NOT NULL DEFAULT (''), "gmailThreadId" varchar NOT NULL DEFAULT (''), "gmailAttachmentId" varchar NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "revenue_document_candidates"("id", "companyId", "mailMessageId", "attachmentIndex", "filename", "mimeType", "sizeBytes", "contentHash", "proposedKind", "proposedResourceType", "proposedResourceId", "confidence", "alternativesJson", "status", "revenueDocumentId", "reviewNote", "reviewedAt", "reviewedByUserId", "createdAt", "gmailMessageId", "gmailThreadId", "gmailAttachmentId") SELECT "id", "companyId", "mailMessageId", "attachmentIndex", "filename", "mimeType", "sizeBytes", "contentHash", "proposedKind", "proposedResourceType", "proposedResourceId", "confidence", "alternativesJson", "status", "revenueDocumentId", "reviewNote", "reviewedAt", "reviewedByUserId", "createdAt", "gmailMessageId", "gmailThreadId", "gmailAttachmentId" FROM "temporary_revenue_document_candidates"`);
        await queryRunner.query(`DROP TABLE "temporary_revenue_document_candidates"`);
        await queryRunner.query(`CREATE INDEX "IDX_0fcf2d66be620de74590adc735" ON "revenue_document_candidates" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d1ce59fcc6aebe6406ca134b8e" ON "revenue_document_candidates" ("companyId", "mailMessageId", "attachmentIndex") `);
        await queryRunner.query(`CREATE INDEX "IDX_14a36a18e0a6ebc09681150694" ON "revenue_document_candidates" ("companyId", "contentHash") `);
        await queryRunner.query(`DROP INDEX "IDX_725f4c1a7d34b794290b0ac08b"`);
        await queryRunner.query(`DROP INDEX "IDX_e6e1e6843d68df6880c73fdb8b"`);
        await queryRunner.query(`DROP INDEX "IDX_3ecbf03e13486b18a729e2f392"`);
        await queryRunner.query(`DROP INDEX "IDX_8e2f3e906b858cae25a64c27ce"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" RENAME TO "temporary_revenue_documents"`);
        await queryRunner.query(`CREATE TABLE "revenue_documents" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "title" varchar NOT NULL, "notes" text NOT NULL DEFAULT (''), "dealId" varchar, "customerId" varchar, "partnershipId" varchar, "contactId" varchar, "attachmentId" varchar, "sourceMailMessageId" varchar, "externalUrl" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "sourceAttachmentIndex" integer, "sourceAttachmentHash" varchar NOT NULL DEFAULT (''), "sourceGmailMessageId" varchar NOT NULL DEFAULT (''), "sourceGmailThreadId" varchar NOT NULL DEFAULT (''), "sourceGmailAttachmentId" varchar NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "revenue_documents"("id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt", "sourceAttachmentIndex", "sourceAttachmentHash", "sourceGmailMessageId", "sourceGmailThreadId", "sourceGmailAttachmentId") SELECT "id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt", "sourceAttachmentIndex", "sourceAttachmentHash", "sourceGmailMessageId", "sourceGmailThreadId", "sourceGmailAttachmentId" FROM "temporary_revenue_documents"`);
        await queryRunner.query(`DROP TABLE "temporary_revenue_documents"`);
        await queryRunner.query(`CREATE INDEX "IDX_725f4c1a7d34b794290b0ac08b" ON "revenue_documents" ("companyId", "contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e6e1e6843d68df6880c73fdb8b" ON "revenue_documents" ("companyId", "partnershipId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3ecbf03e13486b18a729e2f392" ON "revenue_documents" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e2f3e906b858cae25a64c27ce" ON "revenue_documents" ("companyId", "dealId") `);
        await queryRunner.query(`CREATE INDEX "IDX_01ecfb4195a7951a278c7c56dd" ON "revenue_document_candidates" ("companyId", "gmailMessageId", "gmailAttachmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c349795be800f0a51de41ca5af" ON "revenue_documents" ("companyId", "sourceGmailMessageId", "sourceGmailAttachmentId") `);
    }

}
