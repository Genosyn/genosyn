import { MigrationInterface, QueryRunner } from "typeorm";

export class AiNativeSignatures1786524136211 implements MigrationInterface {
    name = 'AiNativeSignatures1786524136211'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "signature_envelopes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "customerId" character varying, "title" character varying NOT NULL, "message" text NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'draft', "routingMode" character varying NOT NULL DEFAULT 'parallel', "originalFilename" character varying NOT NULL, "originalMimeType" character varying NOT NULL DEFAULT 'application/pdf', "originalSizeBytes" bigint NOT NULL DEFAULT '0', "originalStorageKey" character varying NOT NULL, "originalPageCount" integer NOT NULL DEFAULT '0', "documentText" text NOT NULL DEFAULT '', "originalSha256" character varying NOT NULL DEFAULT '', "completedStorageKey" character varying, "completedSizeBytes" bigint NOT NULL DEFAULT '0', "completedSha256" character varying NOT NULL DEFAULT '', "customerContractId" character varying, "expiresAt" TIMESTAMP WITH TIME ZONE, "sentAt" TIMESTAMP WITH TIME ZONE, "completedAt" TIMESTAMP WITH TIME ZONE, "declinedAt" TIMESTAMP WITH TIME ZONE, "declineReason" text NOT NULL DEFAULT '', "voidedAt" TIMESTAMP WITH TIME ZONE, "voidReason" text NOT NULL DEFAULT '', "expiredAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6423640845eb5e4ef2fae0229ab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0da1367dbdd073ff74f5c7eed9" ON "signature_envelopes" ("customerContractId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ac489f81cad45fe3dcb2b6e9b" ON "signature_envelopes" ("status", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bb6566684b7205f61bf30e5d1f" ON "signature_envelopes" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5537f603bea9afe80ae9fba7c" ON "signature_envelopes" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "signature_recipients" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "envelopeId" character varying NOT NULL, "role" character varying NOT NULL DEFAULT 'signer', "name" character varying NOT NULL, "email" character varying NOT NULL, "routingOrder" integer NOT NULL DEFAULT '0', "status" character varying NOT NULL DEFAULT 'waiting', "tokenHash" character varying, "lastDeliveryStatus" character varying NOT NULL DEFAULT 'pending', "lastDeliveryError" text NOT NULL DEFAULT '', "lastDeliveredAt" TIMESTAMP WITH TIME ZONE, "reminderCount" integer NOT NULL DEFAULT '0', "viewedAt" TIMESTAMP WITH TIME ZONE, "consentedAt" TIMESTAMP WITH TIME ZONE, "completedAt" TIMESTAMP WITH TIME ZONE, "declinedAt" TIMESTAMP WITH TIME ZONE, "declineReason" text NOT NULL DEFAULT '', "ipAddress" character varying NOT NULL DEFAULT '', "userAgent" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c4cc85932be17f25ed10937b8bc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_signature_recipients_token_hash" ON "signature_recipients" ("tokenHash") WHERE "tokenHash" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_2b0c13ffa06320d74acc7111e5" ON "signature_recipients" ("companyId", "email") `);
        await queryRunner.query(`CREATE INDEX "IDX_b6bdfe93d9a5732e420099d602" ON "signature_recipients" ("envelopeId", "routingOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_f8e496676e1fa8b1b05a8361ed" ON "signature_recipients" ("companyId", "envelopeId") `);
        await queryRunner.query(`CREATE TABLE "signature_fields" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "envelopeId" character varying NOT NULL, "recipientId" character varying NOT NULL, "type" character varying NOT NULL, "label" character varying NOT NULL DEFAULT '', "placeholder" character varying NOT NULL DEFAULT '', "required" boolean NOT NULL DEFAULT true, "pageNumber" integer NOT NULL, "x" double precision NOT NULL, "y" double precision NOT NULL, "width" double precision NOT NULL, "height" double precision NOT NULL, "valueJson" text NOT NULL DEFAULT 'null', "completedAt" TIMESTAMP WITH TIME ZONE, "sortOrder" double precision NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0f3dd8ef4c679862d30ee059c5d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_20f368823a3188d75f9d1a08b6" ON "signature_fields" ("recipientId", "sortOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_4bbc02ede82e62e0b893c4174e" ON "signature_fields" ("envelopeId", "pageNumber", "sortOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_e488bd84ea73c7894092edb62c" ON "signature_fields" ("companyId", "envelopeId") `);
        await queryRunner.query(`CREATE TABLE "signature_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "envelopeId" character varying NOT NULL, "recipientId" character varying, "type" character varying NOT NULL, "actorKind" character varying NOT NULL, "actorId" character varying, "ipAddress" character varying NOT NULL DEFAULT '', "userAgent" text NOT NULL DEFAULT '', "metadataJson" text NOT NULL DEFAULT '{}', "previousHash" character varying NOT NULL DEFAULT '', "eventHash" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d993f8da8c3ac67228e91f79c45" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d1789d48428ffddab52aeaf87e" ON "signature_events" ("recipientId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_61c6f24107f43411e5c235f330" ON "signature_events" ("companyId", "envelopeId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "employee_signing_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8fa45a3ca14a67c03176b562452" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6fef9287dfdaf94dcdd6d62383" ON "employee_signing_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f78b80a31abb1ee226bba80f03" ON "employee_signing_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_f78b80a31abb1ee226bba80f03"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6fef9287dfdaf94dcdd6d62383"`);
        await queryRunner.query(`DROP TABLE "employee_signing_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_61c6f24107f43411e5c235f330"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d1789d48428ffddab52aeaf87e"`);
        await queryRunner.query(`DROP TABLE "signature_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e488bd84ea73c7894092edb62c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4bbc02ede82e62e0b893c4174e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_20f368823a3188d75f9d1a08b6"`);
        await queryRunner.query(`DROP TABLE "signature_fields"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f8e496676e1fa8b1b05a8361ed"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b6bdfe93d9a5732e420099d602"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2b0c13ffa06320d74acc7111e5"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_signature_recipients_token_hash"`);
        await queryRunner.query(`DROP TABLE "signature_recipients"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d5537f603bea9afe80ae9fba7c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bb6566684b7205f61bf30e5d1f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6ac489f81cad45fe3dcb2b6e9b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0da1367dbdd073ff74f5c7eed9"`);
        await queryRunner.query(`DROP TABLE "signature_envelopes"`);
    }

}
