import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueGapClosure1785224820605 implements MigrationInterface {
    name = 'RevenueGapClosure1785224820605'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "revenue_firmographic_lookups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "customerId" character varying NOT NULL, "connectionId" character varying NOT NULL, "provider" character varying NOT NULL, "providerRecordId" character varying NOT NULL DEFAULT '', "status" character varying NOT NULL, "normalizedSnapshotJson" text NOT NULL DEFAULT '{}', "confidence" integer NOT NULL DEFAULT '0', "lastAttemptedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastMatchedAt" TIMESTAMP WITH TIME ZONE, "observedAt" TIMESTAMP WITH TIME ZONE, "lastError" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a96eee747e8e83a9518c114f574" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7a50228bc0a1f09399e743f3b6" ON "revenue_firmographic_lookups" ("companyId", "status", "lastAttemptedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_539725763547946eaca6053f49" ON "revenue_firmographic_lookups" ("companyId", "customerId", "connectionId") `);
        await queryRunner.query(`ALTER TABLE "customers" ADD "headquartersAddress" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "customers" ADD "parentCompanyName" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "customers" ADD "parentCompanyDomain" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "revenue_import_batches" ADD "sourceConnectionId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "revenue_import_batches" DROP COLUMN "sourceConnectionId"`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "parentCompanyDomain"`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "parentCompanyName"`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "headquartersAddress"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_539725763547946eaca6053f49"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7a50228bc0a1f09399e743f3b6"`);
        await queryRunner.query(`DROP TABLE "revenue_firmographic_lookups"`);
    }

}
