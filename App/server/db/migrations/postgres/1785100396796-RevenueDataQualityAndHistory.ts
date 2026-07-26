import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueDataQualityAndHistory1785100396796 implements MigrationInterface {
    name = 'RevenueDataQualityAndHistory1785100396796'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "revenue_operations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "kind" character varying NOT NULL, "resourceType" character varying NOT NULL, "status" character varying NOT NULL, "idempotencyKey" character varying, "sourceId" character varying, "targetId" character varying, "requestJson" text NOT NULL, "summaryJson" text NOT NULL, "completedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "rolledBackAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a97a9651d9b85499939e6fe09b9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_df0943521178b2cbd3f0db5753" ON "revenue_operations" ("companyId", "idempotencyKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_76efceacf91c54942fb49c48a7" ON "revenue_operations" ("companyId", "resourceType", "sourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d05e279b5b9d6180a6340c6346" ON "revenue_operations" ("companyId", "kind", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_eae51586a639f0e22d7cdb6a5b" ON "revenue_operations" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "revenue_operation_rows" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "operationId" character varying NOT NULL, "resourceType" character varying NOT NULL, "resourceId" character varying NOT NULL, "entityType" character varying NOT NULL, "action" character varying NOT NULL, "status" character varying NOT NULL, "beforeJson" text NOT NULL, "afterJson" text NOT NULL, "detail" text NOT NULL DEFAULT '', "sortOrder" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9ed41b182f05e228583e2611c3a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4ac3347340f4359ec80b1b49cf" ON "revenue_operation_rows" ("companyId", "resourceType", "resourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d150bf2dc66b97a7c8147b98ca" ON "revenue_operation_rows" ("operationId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "revenue_record_aliases" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "resourceType" character varying NOT NULL, "recordId" character varying NOT NULL, "aliasType" character varying NOT NULL, "value" character varying NOT NULL, "normalizedValue" character varying NOT NULL, "sourceRecordId" character varying, "operationId" character varying, "provenance" character varying NOT NULL DEFAULT '', "verified" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f8f06841b7ca40ab9a5a503c2ea" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_049c821291217c63b40faa2fa3" ON "revenue_record_aliases" ("operationId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1e8b370cd8151fb884a1d9d6e4" ON "revenue_record_aliases" ("companyId", "resourceType", "recordId") `);
        await queryRunner.query(`CREATE INDEX "IDX_fd890ab0c4b25d710d1e69181d" ON "revenue_record_aliases" ("companyId", "resourceType", "normalizedValue") `);
        await queryRunner.query(`CREATE TABLE "deal_history_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "dealId" character varying NOT NULL, "kind" character varying NOT NULL, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "fromStageId" character varying, "toStageId" character varying, "fromAmountCents" integer, "toAmountCents" integer, "currency" character varying NOT NULL DEFAULT '', "fromOwnerId" character varying, "fromOwnerEmployeeId" character varying, "toOwnerId" character varying, "toOwnerEmployeeId" character varying, "lostReason" character varying NOT NULL DEFAULT '', "sourceKind" character varying NOT NULL, "sourceKey" character varying NOT NULL, "sourceActivityId" character varying, "metadataJson" text NOT NULL DEFAULT '', "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b293652c028e744d2c13784b61c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c057d3062cabc6888223d4697e" ON "deal_history_events" ("sourceActivityId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a5ecc1eb4848b8027afdb44d5f" ON "deal_history_events" ("companyId", "sourceKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_21cb2b0f2965dbb7d32bc8a7a1" ON "deal_history_events" ("companyId", "kind", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_be7b293a90079f66f074e77a0c" ON "deal_history_events" ("companyId", "dealId", "occurredAt") `);
        await queryRunner.query(`CREATE TABLE "revenue_import_rows" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "batchId" character varying NOT NULL, "resourceType" character varying NOT NULL, "sourceId" character varying NOT NULL, "nativeId" character varying, "action" character varying NOT NULL, "status" character varying NOT NULL, "reason" text NOT NULL DEFAULT '', "decisionJson" text NOT NULL, "sortOrder" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e2771d9371a8050464938d6a175" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_aec0bde37d3684f56108a437f9" ON "revenue_import_rows" ("companyId", "sourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_251d1a007d84bfbc4f10f2b6d2" ON "revenue_import_rows" ("companyId", "resourceType", "nativeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_709ccce21c3a83006dbcc98561" ON "revenue_import_rows" ("batchId", "sortOrder") `);
        await queryRunner.query(`CREATE TABLE "revenue_field_evidence" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "resourceType" character varying NOT NULL, "resourceId" character varying NOT NULL, "fieldKey" character varying NOT NULL, "sourceType" character varying NOT NULL, "sourceId" character varying NOT NULL, "sourceLabel" character varying NOT NULL DEFAULT '', "extractedValueJson" text NOT NULL, "normalizedValue" character varying NOT NULL DEFAULT '', "confidence" integer NOT NULL, "status" character varying NOT NULL, "extractedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastVerifiedAt" TIMESTAMP WITH TIME ZONE, "humanConfirmedAt" TIMESTAMP WITH TIME ZONE, "humanConfirmedById" character varying, "metadataJson" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_152d2f25394e49704f03df2fb8d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b89b64e49cf636fad902acf16a" ON "revenue_field_evidence" ("companyId", "sourceType", "sourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4673bd35ffbca5ea004ccd2f30" ON "revenue_field_evidence" ("companyId", "resourceType", "resourceId", "fieldKey", "status") `);
        await queryRunner.query(`CREATE TABLE "revenue_document_candidates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "mailMessageId" character varying NOT NULL, "attachmentIndex" integer NOT NULL, "filename" character varying NOT NULL, "mimeType" character varying NOT NULL, "sizeBytes" bigint NOT NULL DEFAULT '0', "contentHash" character varying NOT NULL DEFAULT '', "proposedKind" character varying NOT NULL, "proposedResourceType" character varying, "proposedResourceId" character varying, "confidence" integer NOT NULL, "alternativesJson" text NOT NULL, "status" character varying NOT NULL, "revenueDocumentId" character varying, "reviewNote" text NOT NULL DEFAULT '', "reviewedAt" TIMESTAMP WITH TIME ZONE, "reviewedByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5d95c413fc069e6c7e42ab63af9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_14a36a18e0a6ebc09681150694" ON "revenue_document_candidates" ("companyId", "contentHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d1ce59fcc6aebe6406ca134b8e" ON "revenue_document_candidates" ("companyId", "mailMessageId", "attachmentIndex") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fcf2d66be620de74590adc735" ON "revenue_document_candidates" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "revenue_duplicate_candidates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "resourceType" character varying NOT NULL, "leftId" character varying NOT NULL, "rightId" character varying NOT NULL, "score" integer NOT NULL, "reasonsJson" text NOT NULL, "status" character varying NOT NULL, "mergeOperationId" character varying, "detectedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "resolvedAt" TIMESTAMP WITH TIME ZONE, "resolvedByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_281fb3d6c10c030418ba5a24edc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3fdd9c40c226aade6f99f7ec03" ON "revenue_duplicate_candidates" ("companyId", "resourceType", "leftId", "rightId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1593c6f1ca31f876ff2eb0b8f4" ON "revenue_duplicate_candidates" ("companyId", "resourceType", "status", "score") `);
        await queryRunner.query(`ALTER TABLE "revenue_documents" ADD "sourceAttachmentIndex" integer`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" ADD "sourceAttachmentHash" character varying NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "revenue_documents" DROP COLUMN "sourceAttachmentHash"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" DROP COLUMN "sourceAttachmentIndex"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1593c6f1ca31f876ff2eb0b8f4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3fdd9c40c226aade6f99f7ec03"`);
        await queryRunner.query(`DROP TABLE "revenue_duplicate_candidates"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0fcf2d66be620de74590adc735"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d1ce59fcc6aebe6406ca134b8e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_14a36a18e0a6ebc09681150694"`);
        await queryRunner.query(`DROP TABLE "revenue_document_candidates"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4673bd35ffbca5ea004ccd2f30"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b89b64e49cf636fad902acf16a"`);
        await queryRunner.query(`DROP TABLE "revenue_field_evidence"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_709ccce21c3a83006dbcc98561"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_251d1a007d84bfbc4f10f2b6d2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aec0bde37d3684f56108a437f9"`);
        await queryRunner.query(`DROP TABLE "revenue_import_rows"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_be7b293a90079f66f074e77a0c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_21cb2b0f2965dbb7d32bc8a7a1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a5ecc1eb4848b8027afdb44d5f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c057d3062cabc6888223d4697e"`);
        await queryRunner.query(`DROP TABLE "deal_history_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fd890ab0c4b25d710d1e69181d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1e8b370cd8151fb884a1d9d6e4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_049c821291217c63b40faa2fa3"`);
        await queryRunner.query(`DROP TABLE "revenue_record_aliases"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d150bf2dc66b97a7c8147b98ca"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4ac3347340f4359ec80b1b49cf"`);
        await queryRunner.query(`DROP TABLE "revenue_operation_rows"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eae51586a639f0e22d7cdb6a5b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d05e279b5b9d6180a6340c6346"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_76efceacf91c54942fb49c48a7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_df0943521178b2cbd3f0db5753"`);
        await queryRunner.query(`DROP TABLE "revenue_operations"`);
    }

}
