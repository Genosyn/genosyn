import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueProvenanceAndDocumentCapture1785181386401 implements MigrationInterface {
    name = 'RevenueProvenanceAndDocumentCapture1785181386401'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "revenue_documents" ADD "sourceGmailMessageId" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" ADD "sourceGmailThreadId" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" ADD "sourceGmailAttachmentId" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" ADD "verificationState" character varying NOT NULL DEFAULT 'unverified'`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" ADD "extractionMethod" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" ADD "observedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" ADD "verifyingActorType" character varying`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" ADD "verifyingActorId" character varying`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" ADD "gmailMessageId" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" ADD "gmailThreadId" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" ADD "gmailAttachmentId" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`CREATE INDEX "IDX_c349795be800f0a51de41ca5af" ON "revenue_documents" ("companyId", "sourceGmailMessageId", "sourceGmailAttachmentId") `);
        await queryRunner.query(`CREATE INDEX "IDX_01ecfb4195a7951a278c7c56dd" ON "revenue_document_candidates" ("companyId", "gmailMessageId", "gmailAttachmentId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_01ecfb4195a7951a278c7c56dd"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c349795be800f0a51de41ca5af"`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" DROP COLUMN "gmailAttachmentId"`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" DROP COLUMN "gmailThreadId"`);
        await queryRunner.query(`ALTER TABLE "revenue_document_candidates" DROP COLUMN "gmailMessageId"`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" DROP COLUMN "verifyingActorId"`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" DROP COLUMN "verifyingActorType"`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" DROP COLUMN "observedAt"`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" DROP COLUMN "extractionMethod"`);
        await queryRunner.query(`ALTER TABLE "revenue_field_evidence" DROP COLUMN "verificationState"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" DROP COLUMN "sourceGmailAttachmentId"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" DROP COLUMN "sourceGmailThreadId"`);
        await queryRunner.query(`ALTER TABLE "revenue_documents" DROP COLUMN "sourceGmailMessageId"`);
    }

}
