import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceSubsidiaries1790593581649 implements MigrationInterface {
    name = 'InvoiceSubsidiaries1790593581649'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "subsidiaries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "address" text NOT NULL DEFAULT '', "country" character varying NOT NULL DEFAULT '', "taxNumber" character varying NOT NULL DEFAULT '', "registrationNumber" character varying NOT NULL DEFAULT '', "email" character varying NOT NULL DEFAULT '', "phone" character varying NOT NULL DEFAULT '', "website" character varying NOT NULL DEFAULT '', "footer" text NOT NULL DEFAULT '', "archived" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_34ded851c22b6628bfc8e3bd236" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2988d6bf38e905567277492d73" ON "subsidiaries" ("companyId", "archived") `);
        await queryRunner.query(`ALTER TABLE "invoices" ADD "subsidiaryId" character varying`);
        await queryRunner.query(`ALTER TABLE "invoices" ADD "issuerSnapshot" text`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" ADD "subsidiaryId" character varying`);
        await queryRunner.query(`ALTER TABLE "estimates" ADD "subsidiaryId" character varying`);
        await queryRunner.query(`ALTER TABLE "estimates" ADD "issuerSnapshot" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "estimates" DROP COLUMN "issuerSnapshot"`);
        await queryRunner.query(`ALTER TABLE "estimates" DROP COLUMN "subsidiaryId"`);
        await queryRunner.query(`ALTER TABLE "recurring_invoices" DROP COLUMN "subsidiaryId"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "issuerSnapshot"`);
        await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "subsidiaryId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2988d6bf38e905567277492d73"`);
        await queryRunner.query(`DROP TABLE "subsidiaries"`);
    }

}
