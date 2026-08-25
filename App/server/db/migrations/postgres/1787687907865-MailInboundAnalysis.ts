import { MigrationInterface, QueryRunner } from "typeorm";

export class MailInboundAnalysis1787687907865 implements MigrationInterface {
    name = 'MailInboundAnalysis1787687907865'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_inbound_analyses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "accountId" character varying NOT NULL, "threadId" character varying NOT NULL, "messageId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'running', "employeeId" character varying, "modelId" character varying, "category" character varying NOT NULL DEFAULT '', "summary" text NOT NULL DEFAULT '', "actionsJson" text NOT NULL DEFAULT '[]', "errorMessage" text NOT NULL DEFAULT '', "finishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f22d7d84130d07f186fa8d38fef" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_282e4280bb27e3440baae62d4b" ON "mail_inbound_analyses" ("messageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_064226a7f1303b8f8e4ffb47fa" ON "mail_inbound_analyses" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7c1c48e89e0b83b24910a71d42" ON "mail_inbound_analyses" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_adbb2d33d5d7b3c5833876fa5b" ON "mail_inbound_analyses" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "aiAnalysisEnabled" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "aiAnalysisEmployeeId" character varying`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "aiAnalysisModelId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "aiAnalysisModelId"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "aiAnalysisEmployeeId"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "aiAnalysisEnabled"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_adbb2d33d5d7b3c5833876fa5b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7c1c48e89e0b83b24910a71d42"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_064226a7f1303b8f8e4ffb47fa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_282e4280bb27e3440baae62d4b"`);
        await queryRunner.query(`DROP TABLE "mail_inbound_analyses"`);
    }

}
