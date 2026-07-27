import { MigrationInterface, QueryRunner } from "typeorm";

export class GmailDocumentCaptureConcurrency1785185263018 implements MigrationInterface {
    name = 'GmailDocumentCaptureConcurrency1785185263018'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c349795be800f0a51de41ca5af"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_01ecfb4195a7951a278c7c56dd"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" ADD "captureDedupeHash" character varying`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" ADD "processingAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" ADD "processingToken" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_revenue_documents_capture_dedupe_hash" ON "revenue_documents" ("companyId", "captureDedupeHash") WHERE "captureDedupeHash" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_revenue_documents_gmail_attachment" ON "revenue_documents" ("companyId", "sourceGmailMessageId", "sourceGmailAttachmentId") WHERE "sourceGmailMessageId" <> '' AND "sourceGmailAttachmentId" <> ''`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_revenue_document_candidates_gmail_attachment" ON "revenue_document_candidates" ("companyId", "gmailMessageId", "gmailAttachmentId") WHERE "gmailMessageId" <> '' AND "gmailAttachmentId" <> ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."UQ_revenue_document_candidates_gmail_attachment"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_revenue_documents_gmail_attachment"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_revenue_documents_capture_dedupe_hash"`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" DROP COLUMN "processingToken"`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" DROP COLUMN "processingAt"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" DROP COLUMN "captureDedupeHash"`);
        await queryRunner.query(`CREATE INDEX "IDX_01ecfb4195a7951a278c7c56dd" ON "revenue_document_candidates" ("companyId", "gmailMessageId", "gmailAttachmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c349795be800f0a51de41ca5af" ON "revenue_documents" ("companyId", "sourceGmailMessageId", "sourceGmailAttachmentId") `);
    }

}
