import { MigrationInterface, QueryRunner } from "typeorm";

export class AutonomousMarketingAgency1785138686351 implements MigrationInterface {
    name = 'AutonomousMarketingAgency1785138686351'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "marketing_campaigns" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "objective" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'draft', "autonomyMode" character varying NOT NULL DEFAULT 'observe', "channel" character varying NOT NULL DEFAULT '', "connectionId" character varying, "externalAccountId" character varying NOT NULL DEFAULT '', "externalCampaignId" character varying NOT NULL DEFAULT '', "ownerEmployeeId" character varying, "brief" text NOT NULL DEFAULT '', "audience" text NOT NULL DEFAULT '', "offer" text NOT NULL DEFAULT '', "landingPageUrl" character varying NOT NULL DEFAULT '', "successMetric" character varying NOT NULL DEFAULT 'conversions', "targetValue" character varying NOT NULL DEFAULT '', "dailyBudgetMinor" integer NOT NULL DEFAULT '0', "currency" character varying NOT NULL DEFAULT 'USD', "startsAt" TIMESTAMP WITH TIME ZONE, "endsAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2601ceb29654c2a8adfddf2abbf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_75ca47bbb4d25852ddea815431" ON "marketing_campaigns" ("companyId", "connectionId", "externalCampaignId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4d9c9c053bb724e645a5b34f58" ON "marketing_campaigns" ("companyId", "ownerEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_86573e6c78285e31926428349d" ON "marketing_campaigns" ("companyId", "status") `);
        await queryRunner.query(`CREATE TABLE "marketing_creatives" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "campaignId" character varying NOT NULL, "name" character varying NOT NULL, "format" character varying NOT NULL DEFAULT 'text', "status" character varying NOT NULL DEFAULT 'draft', "variantGroup" character varying NOT NULL DEFAULT '', "concept" text NOT NULL DEFAULT '', "headline" text NOT NULL DEFAULT '', "body" text NOT NULL DEFAULT '', "callToAction" character varying NOT NULL DEFAULT '', "assetUrl" character varying NOT NULL DEFAULT '', "destinationUrl" character varying NOT NULL DEFAULT '', "externalCreativeId" character varying NOT NULL DEFAULT '', "reviewNote" text NOT NULL DEFAULT '', "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4e735b0376814ff472cd8793cb3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_94b1f69e412d0aacf7724d0a69" ON "marketing_creatives" ("companyId", "variantGroup") `);
        await queryRunner.query(`CREATE INDEX "IDX_f073065b36f1899c39000198c5" ON "marketing_creatives" ("companyId", "campaignId", "status") `);
        await queryRunner.query(`CREATE TABLE "marketing_experiments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "campaignId" character varying NOT NULL, "name" character varying NOT NULL, "hypothesis" text NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'draft', "primaryMetric" character varying NOT NULL DEFAULT 'conversions', "minimumSampleSize" character varying NOT NULL DEFAULT '', "creativeIdsJson" text NOT NULL DEFAULT '[]', "winnerCreativeId" character varying, "decisionRationale" text NOT NULL DEFAULT '', "startsAt" TIMESTAMP WITH TIME ZONE, "endsAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a507bcb7b375f618ae9de5f9be9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_338ae942d06dbefb6791266291" ON "marketing_experiments" ("companyId", "campaignId", "status") `);
        await queryRunner.query(`CREATE TABLE "marketing_performance_snapshots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "campaignId" character varying NOT NULL, "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL, "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL, "spendMinor" integer NOT NULL DEFAULT '0', "impressions" integer NOT NULL DEFAULT '0', "clicks" integer NOT NULL DEFAULT '0', "conversions" character varying NOT NULL DEFAULT '0', "conversionValue" character varying NOT NULL DEFAULT '0', "currency" character varying NOT NULL DEFAULT 'USD', "source" character varying NOT NULL DEFAULT '', "rawJson" text NOT NULL DEFAULT '{}', "recordedByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_86c39055327be727444a64dbee7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4217fc034801bec18f8d432ecd" ON "marketing_performance_snapshots" ("companyId", "campaignId", "periodEnd") `);
        await queryRunner.query(`CREATE TABLE "employee_marketing_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_58eaeb83467083b2faca5087cf4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4dc4ead23563876660071b511d" ON "employee_marketing_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a8df6c1e9dbcdb6d4513e09daf" ON "employee_marketing_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a8df6c1e9dbcdb6d4513e09daf"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4dc4ead23563876660071b511d"`);
        await queryRunner.query(`DROP TABLE "employee_marketing_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4217fc034801bec18f8d432ecd"`);
        await queryRunner.query(`DROP TABLE "marketing_performance_snapshots"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_338ae942d06dbefb6791266291"`);
        await queryRunner.query(`DROP TABLE "marketing_experiments"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f073065b36f1899c39000198c5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_94b1f69e412d0aacf7724d0a69"`);
        await queryRunner.query(`DROP TABLE "marketing_creatives"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_86573e6c78285e31926428349d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4d9c9c053bb724e645a5b34f58"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_75ca47bbb4d25852ddea815431"`);
        await queryRunner.query(`DROP TABLE "marketing_campaigns"`);
    }

}
