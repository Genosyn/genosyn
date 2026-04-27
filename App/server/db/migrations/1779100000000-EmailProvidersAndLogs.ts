import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-company email providers + an append-only delivery log.
 *
 *   - `email_providers`: one row per configured transport (SMTP, SendGrid,
 *     Mailgun, Resend, Postmark, …). Credentials live in `encryptedConfig`,
 *     encrypted with the same sessionSecret-derived AES-256-GCM key as
 *     `secrets` and `integration_connections`. A company can mark exactly
 *     one row as `isDefault`; non-default rows are kept as drafts.
 *   - `email_logs`: every notification email Genosyn attempted to deliver.
 *     `companyId` is nullable so system-level sends (signup welcome,
 *     password reset) still land in the table for global debugging.
 */
export class EmailProvidersAndLogs1779100000000 implements MigrationInterface {
  name = "EmailProvidersAndLogs1779100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "email_providers" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "fromAddress" varchar NOT NULL,
        "replyTo" varchar NOT NULL DEFAULT (''),
        "encryptedConfig" text NOT NULL,
        "isDefault" boolean NOT NULL DEFAULT (0),
        "enabled" boolean NOT NULL DEFAULT (1),
        "lastTestedAt" datetime,
        "lastTestStatus" varchar,
        "lastTestMessage" varchar NOT NULL DEFAULT (''),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_providers_companyId" ON "email_providers" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_providers_company_default" ON "email_providers" ("companyId", "isDefault")`,
    );

    await queryRunner.query(
      `CREATE TABLE "email_logs" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar,
        "providerId" varchar,
        "transport" varchar NOT NULL,
        "purpose" varchar NOT NULL DEFAULT ('other'),
        "toAddress" varchar NOT NULL,
        "fromAddress" varchar NOT NULL DEFAULT (''),
        "subject" varchar NOT NULL,
        "bodyPreview" text NOT NULL DEFAULT (''),
        "status" varchar NOT NULL DEFAULT ('sent'),
        "errorMessage" varchar NOT NULL DEFAULT (''),
        "messageId" varchar NOT NULL DEFAULT (''),
        "triggeredByUserId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_logs_company_createdAt" ON "email_logs" ("companyId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_email_logs_status" ON "email_logs" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_email_logs_status"`);
    await queryRunner.query(`DROP INDEX "IDX_email_logs_company_createdAt"`);
    await queryRunner.query(`DROP TABLE "email_logs"`);
    await queryRunner.query(`DROP INDEX "IDX_email_providers_company_default"`);
    await queryRunner.query(`DROP INDEX "IDX_email_providers_companyId"`);
    await queryRunner.query(`DROP TABLE "email_providers"`);
  }
}
