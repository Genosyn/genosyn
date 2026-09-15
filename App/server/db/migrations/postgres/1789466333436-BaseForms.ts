import { MigrationInterface, QueryRunner } from "typeorm";

export class BaseForms1789466333436 implements MigrationInterface {
    name = 'BaseForms1789466333436'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "base_forms" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "tableId" character varying NOT NULL, "slug" character varying NOT NULL, "title" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "submitLabel" character varying NOT NULL DEFAULT 'Submit', "successTitle" character varying NOT NULL DEFAULT 'Response submitted', "successMessage" text NOT NULL DEFAULT 'Thanks for your response.', "allowAnotherResponse" boolean NOT NULL DEFAULT false, "questionsJson" text NOT NULL DEFAULT '[]', "publishedAt" TIMESTAMP WITH TIME ZONE, "acceptingResponses" boolean NOT NULL DEFAULT true, "tokenHash" character varying NOT NULL, "tokenEncrypted" text NOT NULL, "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_48f532812da22665d81889822c4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4da27a2d8d417886d3d811ee68" ON "base_forms" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_ec93226ff2028861af5ff1756a" ON "base_forms" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_317e303d475dabbcaa53845bb2" ON "base_forms" ("tableId", "slug") `);
        await queryRunner.query(`CREATE TABLE "base_form_submissions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "formId" character varying NOT NULL, "recordId" character varying NOT NULL, "clientSubmissionId" character varying NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f73a9efbd359b8ebb0f9d1a51ad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dfc70ea435a26ac055e74ca4bd" ON "base_form_submissions" ("formId", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ac4645d8cf3856b21a03d7381f" ON "base_form_submissions" ("recordId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a69b26a35024fe6d560d2540e4" ON "base_form_submissions" ("formId", "clientSubmissionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a69b26a35024fe6d560d2540e4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ac4645d8cf3856b21a03d7381f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dfc70ea435a26ac055e74ca4bd"`);
        await queryRunner.query(`DROP TABLE "base_form_submissions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_317e303d475dabbcaa53845bb2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ec93226ff2028861af5ff1756a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4da27a2d8d417886d3d811ee68"`);
        await queryRunner.query(`DROP TABLE "base_forms"`);
    }

}
