import { MigrationInterface, QueryRunner } from "typeorm";

export class BaseForms1789466263529 implements MigrationInterface {
    name = 'BaseForms1789466263529'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "base_forms" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tableId" varchar NOT NULL, "slug" varchar NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "submitLabel" varchar NOT NULL DEFAULT ('Submit'), "successTitle" varchar NOT NULL DEFAULT ('Response submitted'), "successMessage" text NOT NULL DEFAULT ('Thanks for your response.'), "allowAnotherResponse" boolean NOT NULL DEFAULT (0), "questionsJson" text NOT NULL DEFAULT ('[]'), "publishedAt" datetime, "acceptingResponses" boolean NOT NULL DEFAULT (1), "tokenHash" varchar NOT NULL, "tokenEncrypted" text NOT NULL, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4da27a2d8d417886d3d811ee68" ON "base_forms" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_ec93226ff2028861af5ff1756a" ON "base_forms" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_317e303d475dabbcaa53845bb2" ON "base_forms" ("tableId", "slug") `);
        await queryRunner.query(`CREATE TABLE "base_form_submissions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "formId" varchar NOT NULL, "recordId" varchar NOT NULL, "clientSubmissionId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_dfc70ea435a26ac055e74ca4bd" ON "base_form_submissions" ("formId", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ac4645d8cf3856b21a03d7381f" ON "base_form_submissions" ("recordId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a69b26a35024fe6d560d2540e4" ON "base_form_submissions" ("formId", "clientSubmissionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a69b26a35024fe6d560d2540e4"`);
        await queryRunner.query(`DROP INDEX "IDX_ac4645d8cf3856b21a03d7381f"`);
        await queryRunner.query(`DROP INDEX "IDX_dfc70ea435a26ac055e74ca4bd"`);
        await queryRunner.query(`DROP TABLE "base_form_submissions"`);
        await queryRunner.query(`DROP INDEX "IDX_317e303d475dabbcaa53845bb2"`);
        await queryRunner.query(`DROP INDEX "IDX_ec93226ff2028861af5ff1756a"`);
        await queryRunner.query(`DROP INDEX "IDX_4da27a2d8d417886d3d811ee68"`);
        await queryRunner.query(`DROP TABLE "base_forms"`);
    }

}
