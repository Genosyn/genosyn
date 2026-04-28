import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Open-record surface for Bases: comments + file attachments per record.
 *
 * Mirrors the existing TodoComment / Attachment shape so humans and AI
 * employees can post into the same stream and either party can upload files.
 */
export class BaseRecordCommentsAndAttachments1779400000000
  implements MigrationInterface
{
  name = "BaseRecordCommentsAndAttachments1779400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "base_record_comments" (
        "id" varchar PRIMARY KEY NOT NULL,
        "recordId" varchar NOT NULL,
        "authorUserId" varchar,
        "authorEmployeeId" varchar,
        "body" text NOT NULL DEFAULT (''),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_base_record_comments_recordId" ON "base_record_comments" ("recordId")`,
    );

    await queryRunner.query(
      `CREATE TABLE "base_record_attachments" (
        "id" varchar PRIMARY KEY NOT NULL,
        "recordId" varchar NOT NULL,
        "companyId" varchar NOT NULL,
        "filename" varchar NOT NULL,
        "mimeType" varchar NOT NULL DEFAULT ('application/octet-stream'),
        "sizeBytes" bigint NOT NULL DEFAULT (0),
        "storageKey" varchar NOT NULL,
        "uploadedByUserId" varchar,
        "uploadedByEmployeeId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_base_record_attachments_recordId" ON "base_record_attachments" ("recordId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_base_record_attachments_companyId" ON "base_record_attachments" ("companyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_base_record_attachments_companyId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_base_record_attachments_recordId"`,
    );
    await queryRunner.query(`DROP TABLE "base_record_attachments"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_base_record_comments_recordId"`,
    );
    await queryRunner.query(`DROP TABLE "base_record_comments"`);
  }
}
