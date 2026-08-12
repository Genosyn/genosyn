import { MigrationInterface, QueryRunner } from "typeorm";

export class AiNativeSignatures1786523982502 implements MigrationInterface {
    name = 'AiNativeSignatures1786523982502'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "signature_envelopes" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar, "title" varchar NOT NULL, "message" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "routingMode" varchar NOT NULL DEFAULT ('parallel'), "originalFilename" varchar NOT NULL, "originalMimeType" varchar NOT NULL DEFAULT ('application/pdf'), "originalSizeBytes" bigint NOT NULL DEFAULT (0), "originalStorageKey" varchar NOT NULL, "originalPageCount" integer NOT NULL DEFAULT (0), "documentText" text NOT NULL DEFAULT (''), "originalSha256" varchar NOT NULL DEFAULT (''), "completedStorageKey" varchar, "completedSizeBytes" bigint NOT NULL DEFAULT (0), "completedSha256" varchar NOT NULL DEFAULT (''), "customerContractId" varchar, "expiresAt" datetime, "sentAt" datetime, "completedAt" datetime, "declinedAt" datetime, "declineReason" text NOT NULL DEFAULT (''), "voidedAt" datetime, "voidReason" text NOT NULL DEFAULT (''), "expiredAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_0da1367dbdd073ff74f5c7eed9" ON "signature_envelopes" ("customerContractId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ac489f81cad45fe3dcb2b6e9b" ON "signature_envelopes" ("status", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bb6566684b7205f61bf30e5d1f" ON "signature_envelopes" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5537f603bea9afe80ae9fba7c" ON "signature_envelopes" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "signature_recipients" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "envelopeId" varchar NOT NULL, "role" varchar NOT NULL DEFAULT ('signer'), "name" varchar NOT NULL, "email" varchar NOT NULL, "routingOrder" integer NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('waiting'), "tokenHash" varchar, "lastDeliveryStatus" varchar NOT NULL DEFAULT ('pending'), "lastDeliveryError" text NOT NULL DEFAULT (''), "lastDeliveredAt" datetime, "reminderCount" integer NOT NULL DEFAULT (0), "viewedAt" datetime, "consentedAt" datetime, "completedAt" datetime, "declinedAt" datetime, "declineReason" text NOT NULL DEFAULT (''), "ipAddress" varchar NOT NULL DEFAULT (''), "userAgent" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_signature_recipients_token_hash" ON "signature_recipients" ("tokenHash") WHERE "tokenHash" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_2b0c13ffa06320d74acc7111e5" ON "signature_recipients" ("companyId", "email") `);
        await queryRunner.query(`CREATE INDEX "IDX_b6bdfe93d9a5732e420099d602" ON "signature_recipients" ("envelopeId", "routingOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_f8e496676e1fa8b1b05a8361ed" ON "signature_recipients" ("companyId", "envelopeId") `);
        await queryRunner.query(`CREATE TABLE "signature_fields" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "envelopeId" varchar NOT NULL, "recipientId" varchar NOT NULL, "type" varchar NOT NULL, "label" varchar NOT NULL DEFAULT (''), "placeholder" varchar NOT NULL DEFAULT (''), "required" boolean NOT NULL DEFAULT (1), "pageNumber" integer NOT NULL, "x" float NOT NULL, "y" float NOT NULL, "width" float NOT NULL, "height" float NOT NULL, "valueJson" text NOT NULL DEFAULT ('null'), "completedAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_20f368823a3188d75f9d1a08b6" ON "signature_fields" ("recipientId", "sortOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_4bbc02ede82e62e0b893c4174e" ON "signature_fields" ("envelopeId", "pageNumber", "sortOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_e488bd84ea73c7894092edb62c" ON "signature_fields" ("companyId", "envelopeId") `);
        await queryRunner.query(`CREATE TABLE "signature_events" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "envelopeId" varchar NOT NULL, "recipientId" varchar, "type" varchar NOT NULL, "actorKind" varchar NOT NULL, "actorId" varchar, "ipAddress" varchar NOT NULL DEFAULT (''), "userAgent" text NOT NULL DEFAULT (''), "metadataJson" text NOT NULL DEFAULT ('{}'), "previousHash" varchar NOT NULL DEFAULT (''), "eventHash" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_d1789d48428ffddab52aeaf87e" ON "signature_events" ("recipientId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_61c6f24107f43411e5c235f330" ON "signature_events" ("companyId", "envelopeId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "employee_signing_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6fef9287dfdaf94dcdd6d62383" ON "employee_signing_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f78b80a31abb1ee226bba80f03" ON "employee_signing_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f78b80a31abb1ee226bba80f03"`);
        await queryRunner.query(`DROP INDEX "IDX_6fef9287dfdaf94dcdd6d62383"`);
        await queryRunner.query(`DROP TABLE "employee_signing_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_61c6f24107f43411e5c235f330"`);
        await queryRunner.query(`DROP INDEX "IDX_d1789d48428ffddab52aeaf87e"`);
        await queryRunner.query(`DROP TABLE "signature_events"`);
        await queryRunner.query(`DROP INDEX "IDX_e488bd84ea73c7894092edb62c"`);
        await queryRunner.query(`DROP INDEX "IDX_4bbc02ede82e62e0b893c4174e"`);
        await queryRunner.query(`DROP INDEX "IDX_20f368823a3188d75f9d1a08b6"`);
        await queryRunner.query(`DROP TABLE "signature_fields"`);
        await queryRunner.query(`DROP INDEX "IDX_f8e496676e1fa8b1b05a8361ed"`);
        await queryRunner.query(`DROP INDEX "IDX_b6bdfe93d9a5732e420099d602"`);
        await queryRunner.query(`DROP INDEX "IDX_2b0c13ffa06320d74acc7111e5"`);
        await queryRunner.query(`DROP INDEX "UQ_signature_recipients_token_hash"`);
        await queryRunner.query(`DROP TABLE "signature_recipients"`);
        await queryRunner.query(`DROP INDEX "IDX_d5537f603bea9afe80ae9fba7c"`);
        await queryRunner.query(`DROP INDEX "IDX_bb6566684b7205f61bf30e5d1f"`);
        await queryRunner.query(`DROP INDEX "IDX_6ac489f81cad45fe3dcb2b6e9b"`);
        await queryRunner.query(`DROP INDEX "IDX_0da1367dbdd073ff74f5c7eed9"`);
        await queryRunner.query(`DROP TABLE "signature_envelopes"`);
    }

}
