import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueDataQualityAndHistory1785100263009 implements MigrationInterface {
    name = 'RevenueDataQualityAndHistory1785100263009'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "revenue_operations" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "resourceType" varchar NOT NULL, "status" varchar NOT NULL, "idempotencyKey" varchar, "sourceId" varchar, "targetId" varchar, "requestJson" text NOT NULL, "summaryJson" text NOT NULL, "completedAt" datetime NOT NULL, "rolledBackAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_df0943521178b2cbd3f0db5753" ON "revenue_operations" ("companyId", "idempotencyKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_76efceacf91c54942fb49c48a7" ON "revenue_operations" ("companyId", "resourceType", "sourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d05e279b5b9d6180a6340c6346" ON "revenue_operations" ("companyId", "kind", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_eae51586a639f0e22d7cdb6a5b" ON "revenue_operations" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "revenue_operation_rows" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "operationId" varchar NOT NULL, "resourceType" varchar NOT NULL, "resourceId" varchar NOT NULL, "entityType" varchar NOT NULL, "action" varchar NOT NULL, "status" varchar NOT NULL, "beforeJson" text NOT NULL, "afterJson" text NOT NULL, "detail" text NOT NULL DEFAULT (''), "sortOrder" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_4ac3347340f4359ec80b1b49cf" ON "revenue_operation_rows" ("companyId", "resourceType", "resourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d150bf2dc66b97a7c8147b98ca" ON "revenue_operation_rows" ("operationId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "revenue_record_aliases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "resourceType" varchar NOT NULL, "recordId" varchar NOT NULL, "aliasType" varchar NOT NULL, "value" varchar NOT NULL, "normalizedValue" varchar NOT NULL, "sourceRecordId" varchar, "operationId" varchar, "provenance" varchar NOT NULL DEFAULT (''), "verified" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_049c821291217c63b40faa2fa3" ON "revenue_record_aliases" ("operationId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1e8b370cd8151fb884a1d9d6e4" ON "revenue_record_aliases" ("companyId", "resourceType", "recordId") `);
        await queryRunner.query(`CREATE INDEX "IDX_fd890ab0c4b25d710d1e69181d" ON "revenue_record_aliases" ("companyId", "resourceType", "normalizedValue") `);
        await queryRunner.query(`CREATE TABLE "deal_history_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "dealId" varchar NOT NULL, "kind" varchar NOT NULL, "occurredAt" datetime NOT NULL, "fromStageId" varchar, "toStageId" varchar, "fromAmountCents" integer, "toAmountCents" integer, "currency" varchar NOT NULL DEFAULT (''), "fromOwnerId" varchar, "fromOwnerEmployeeId" varchar, "toOwnerId" varchar, "toOwnerEmployeeId" varchar, "lostReason" varchar NOT NULL DEFAULT (''), "sourceKind" varchar NOT NULL, "sourceKey" varchar NOT NULL, "sourceActivityId" varchar, "metadataJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c057d3062cabc6888223d4697e" ON "deal_history_events" ("sourceActivityId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a5ecc1eb4848b8027afdb44d5f" ON "deal_history_events" ("companyId", "sourceKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_21cb2b0f2965dbb7d32bc8a7a1" ON "deal_history_events" ("companyId", "kind", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_be7b293a90079f66f074e77a0c" ON "deal_history_events" ("companyId", "dealId", "occurredAt") `);
        await queryRunner.query(`CREATE TABLE "revenue_import_rows" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "batchId" varchar NOT NULL, "resourceType" varchar NOT NULL, "sourceId" varchar NOT NULL, "nativeId" varchar, "action" varchar NOT NULL, "status" varchar NOT NULL, "reason" text NOT NULL DEFAULT (''), "decisionJson" text NOT NULL, "sortOrder" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_aec0bde37d3684f56108a437f9" ON "revenue_import_rows" ("companyId", "sourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_251d1a007d84bfbc4f10f2b6d2" ON "revenue_import_rows" ("companyId", "resourceType", "nativeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_709ccce21c3a83006dbcc98561" ON "revenue_import_rows" ("batchId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "revenue_field_evidence" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "resourceType" varchar NOT NULL, "resourceId" varchar NOT NULL, "fieldKey" varchar NOT NULL, "sourceType" varchar NOT NULL, "sourceId" varchar NOT NULL, "sourceLabel" varchar NOT NULL DEFAULT (''), "extractedValueJson" text NOT NULL, "normalizedValue" varchar NOT NULL DEFAULT (''), "confidence" integer NOT NULL, "status" varchar NOT NULL, "extractedAt" datetime NOT NULL, "lastVerifiedAt" datetime, "humanConfirmedAt" datetime, "humanConfirmedById" varchar, "metadataJson" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_b89b64e49cf636fad902acf16a" ON "revenue_field_evidence" ("companyId", "sourceType", "sourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4673bd35ffbca5ea004ccd2f30" ON "revenue_field_evidence" ("companyId", "resourceType", "resourceId", "fieldKey", "status") `);
        await queryRunner.query(`CREATE TABLE "revenue_document_candidates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "mailMessageId" varchar NOT NULL, "attachmentIndex" integer NOT NULL, "filename" varchar NOT NULL, "mimeType" varchar NOT NULL, "sizeBytes" bigint NOT NULL DEFAULT (0), "contentHash" varchar NOT NULL DEFAULT (''), "proposedKind" varchar NOT NULL, "proposedResourceType" varchar, "proposedResourceId" varchar, "confidence" integer NOT NULL, "alternativesJson" text NOT NULL, "status" varchar NOT NULL, "revenueDocumentId" varchar, "reviewNote" text NOT NULL DEFAULT (''), "reviewedAt" datetime, "reviewedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_14a36a18e0a6ebc09681150694" ON "revenue_document_candidates" ("companyId", "contentHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d1ce59fcc6aebe6406ca134b8e" ON "revenue_document_candidates" ("companyId", "mailMessageId", "attachmentIndex") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fcf2d66be620de74590adc735" ON "revenue_document_candidates" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "revenue_duplicate_candidates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "resourceType" varchar NOT NULL, "leftId" varchar NOT NULL, "rightId" varchar NOT NULL, "score" integer NOT NULL, "reasonsJson" text NOT NULL, "status" varchar NOT NULL, "mergeOperationId" varchar, "detectedAt" datetime NOT NULL, "resolvedAt" datetime, "resolvedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3fdd9c40c226aade6f99f7ec03" ON "revenue_duplicate_candidates" ("companyId", "resourceType", "leftId", "rightId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1593c6f1ca31f876ff2eb0b8f4" ON "revenue_duplicate_candidates" ("companyId", "resourceType", "status", "score") `);
        await queryRunner.query(`DROP INDEX "IDX_8e2f3e906b858cae25a64c27ce"`);
        await queryRunner.query(`DROP INDEX "IDX_3ecbf03e13486b18a729e2f392"`);
        await queryRunner.query(`DROP INDEX "IDX_e6e1e6843d68df6880c73fdb8b"`);
        await queryRunner.query(`DROP INDEX "IDX_725f4c1a7d34b794290b0ac08b"`);
        await queryRunner.query(`CREATE TABLE "temporary_revenue_documents" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "title" varchar NOT NULL, "notes" text NOT NULL DEFAULT (''), "dealId" varchar, "customerId" varchar, "partnershipId" varchar, "contactId" varchar, "attachmentId" varchar, "sourceMailMessageId" varchar, "externalUrl" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "sourceAttachmentIndex" integer, "sourceAttachmentHash" varchar NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_revenue_documents"("id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt" FROM "revenue_documents"`);
        await queryRunner.query(`DROP TABLE "revenue_documents"`);
        await queryRunner.query(`ALTER TABLE "temporary_revenue_documents" RENAME TO "revenue_documents"`);
        await queryRunner.query(`CREATE INDEX "IDX_8e2f3e906b858cae25a64c27ce" ON "revenue_documents" ("companyId", "dealId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3ecbf03e13486b18a729e2f392" ON "revenue_documents" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e6e1e6843d68df6880c73fdb8b" ON "revenue_documents" ("companyId", "partnershipId") `);
        await queryRunner.query(`CREATE INDEX "IDX_725f4c1a7d34b794290b0ac08b" ON "revenue_documents" ("companyId", "contactId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_725f4c1a7d34b794290b0ac08b"`);
        await queryRunner.query(`DROP INDEX "IDX_e6e1e6843d68df6880c73fdb8b"`);
        await queryRunner.query(`DROP INDEX "IDX_3ecbf03e13486b18a729e2f392"`);
        await queryRunner.query(`DROP INDEX "IDX_8e2f3e906b858cae25a64c27ce"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" RENAME TO "temporary_revenue_documents"`);
        await queryRunner.query(`CREATE TABLE "revenue_documents" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "title" varchar NOT NULL, "notes" text NOT NULL DEFAULT (''), "dealId" varchar, "customerId" varchar, "partnershipId" varchar, "contactId" varchar, "attachmentId" varchar, "sourceMailMessageId" varchar, "externalUrl" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "revenue_documents"("id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "kind", "title", "notes", "dealId", "customerId", "partnershipId", "contactId", "attachmentId", "sourceMailMessageId", "externalUrl", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt" FROM "temporary_revenue_documents"`);
        await queryRunner.query(`DROP TABLE "temporary_revenue_documents"`);
        await queryRunner.query(`CREATE INDEX "IDX_725f4c1a7d34b794290b0ac08b" ON "revenue_documents" ("companyId", "contactId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e6e1e6843d68df6880c73fdb8b" ON "revenue_documents" ("companyId", "partnershipId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3ecbf03e13486b18a729e2f392" ON "revenue_documents" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e2f3e906b858cae25a64c27ce" ON "revenue_documents" ("companyId", "dealId") `);
        await queryRunner.query(`DROP INDEX "IDX_1593c6f1ca31f876ff2eb0b8f4"`);
        await queryRunner.query(`DROP INDEX "IDX_3fdd9c40c226aade6f99f7ec03"`);
        await queryRunner.query(`DROP TABLE "revenue_duplicate_candidates"`);
        await queryRunner.query(`DROP INDEX "IDX_0fcf2d66be620de74590adc735"`);
        await queryRunner.query(`DROP INDEX "IDX_d1ce59fcc6aebe6406ca134b8e"`);
        await queryRunner.query(`DROP INDEX "IDX_14a36a18e0a6ebc09681150694"`);
        await queryRunner.query(`DROP TABLE "revenue_document_candidates"`);
        await queryRunner.query(`DROP INDEX "IDX_4673bd35ffbca5ea004ccd2f30"`);
        await queryRunner.query(`DROP INDEX "IDX_b89b64e49cf636fad902acf16a"`);
        await queryRunner.query(`DROP TABLE "revenue_field_evidence"`);
        await queryRunner.query(`DROP INDEX "IDX_709ccce21c3a83006dbcc98561"`);
        await queryRunner.query(`DROP INDEX "IDX_251d1a007d84bfbc4f10f2b6d2"`);
        await queryRunner.query(`DROP INDEX "IDX_aec0bde37d3684f56108a437f9"`);
        await queryRunner.query(`DROP TABLE "revenue_import_rows"`);
        await queryRunner.query(`DROP INDEX "IDX_be7b293a90079f66f074e77a0c"`);
        await queryRunner.query(`DROP INDEX "IDX_21cb2b0f2965dbb7d32bc8a7a1"`);
        await queryRunner.query(`DROP INDEX "IDX_a5ecc1eb4848b8027afdb44d5f"`);
        await queryRunner.query(`DROP INDEX "IDX_c057d3062cabc6888223d4697e"`);
        await queryRunner.query(`DROP TABLE "deal_history_events"`);
        await queryRunner.query(`DROP INDEX "IDX_fd890ab0c4b25d710d1e69181d"`);
        await queryRunner.query(`DROP INDEX "IDX_1e8b370cd8151fb884a1d9d6e4"`);
        await queryRunner.query(`DROP INDEX "IDX_049c821291217c63b40faa2fa3"`);
        await queryRunner.query(`DROP TABLE "revenue_record_aliases"`);
        await queryRunner.query(`DROP INDEX "IDX_d150bf2dc66b97a7c8147b98ca"`);
        await queryRunner.query(`DROP INDEX "IDX_4ac3347340f4359ec80b1b49cf"`);
        await queryRunner.query(`DROP TABLE "revenue_operation_rows"`);
        await queryRunner.query(`DROP INDEX "IDX_eae51586a639f0e22d7cdb6a5b"`);
        await queryRunner.query(`DROP INDEX "IDX_d05e279b5b9d6180a6340c6346"`);
        await queryRunner.query(`DROP INDEX "IDX_76efceacf91c54942fb49c48a7"`);
        await queryRunner.query(`DROP INDEX "IDX_df0943521178b2cbd3f0db5753"`);
        await queryRunner.query(`DROP TABLE "revenue_operations"`);
    }

}
