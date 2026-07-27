import { MigrationInterface, QueryRunner } from "typeorm";

export class AutonomousMarketingAgency1785138638510 implements MigrationInterface {
    name = 'AutonomousMarketingAgency1785138638510'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "marketing_campaigns" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "objective" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('draft'), "autonomyMode" varchar NOT NULL DEFAULT ('observe'), "channel" varchar NOT NULL DEFAULT (''), "connectionId" varchar, "externalAccountId" varchar NOT NULL DEFAULT (''), "externalCampaignId" varchar NOT NULL DEFAULT (''), "ownerEmployeeId" varchar, "brief" text NOT NULL DEFAULT (''), "audience" text NOT NULL DEFAULT (''), "offer" text NOT NULL DEFAULT (''), "landingPageUrl" varchar NOT NULL DEFAULT (''), "successMetric" varchar NOT NULL DEFAULT ('conversions'), "targetValue" varchar NOT NULL DEFAULT (''), "dailyBudgetMinor" integer NOT NULL DEFAULT (0), "currency" varchar NOT NULL DEFAULT ('USD'), "startsAt" datetime, "endsAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_75ca47bbb4d25852ddea815431" ON "marketing_campaigns" ("companyId", "connectionId", "externalCampaignId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4d9c9c053bb724e645a5b34f58" ON "marketing_campaigns" ("companyId", "ownerEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_86573e6c78285e31926428349d" ON "marketing_campaigns" ("companyId", "status") `);
        await queryRunner.query(`CREATE TABLE "marketing_creatives" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "campaignId" varchar NOT NULL, "name" varchar NOT NULL, "format" varchar NOT NULL DEFAULT ('text'), "status" varchar NOT NULL DEFAULT ('draft'), "variantGroup" varchar NOT NULL DEFAULT (''), "concept" text NOT NULL DEFAULT (''), "headline" text NOT NULL DEFAULT (''), "body" text NOT NULL DEFAULT (''), "callToAction" varchar NOT NULL DEFAULT (''), "assetUrl" varchar NOT NULL DEFAULT (''), "destinationUrl" varchar NOT NULL DEFAULT (''), "externalCreativeId" varchar NOT NULL DEFAULT (''), "reviewNote" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_94b1f69e412d0aacf7724d0a69" ON "marketing_creatives" ("companyId", "variantGroup") `);
        await queryRunner.query(`CREATE INDEX "IDX_f073065b36f1899c39000198c5" ON "marketing_creatives" ("companyId", "campaignId", "status") `);
        await queryRunner.query(`CREATE TABLE "marketing_experiments" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "campaignId" varchar NOT NULL, "name" varchar NOT NULL, "hypothesis" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "primaryMetric" varchar NOT NULL DEFAULT ('conversions'), "minimumSampleSize" varchar NOT NULL DEFAULT (''), "creativeIdsJson" text NOT NULL DEFAULT ('[]'), "winnerCreativeId" varchar, "decisionRationale" text NOT NULL DEFAULT (''), "startsAt" datetime, "endsAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_338ae942d06dbefb6791266291" ON "marketing_experiments" ("companyId", "campaignId", "status") `);
        await queryRunner.query(`CREATE TABLE "marketing_performance_snapshots" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "campaignId" varchar NOT NULL, "periodStart" datetime NOT NULL, "periodEnd" datetime NOT NULL, "spendMinor" integer NOT NULL DEFAULT (0), "impressions" integer NOT NULL DEFAULT (0), "clicks" integer NOT NULL DEFAULT (0), "conversions" varchar NOT NULL DEFAULT ('0'), "conversionValue" varchar NOT NULL DEFAULT ('0'), "currency" varchar NOT NULL DEFAULT ('USD'), "source" varchar NOT NULL DEFAULT (''), "rawJson" text NOT NULL DEFAULT ('{}'), "recordedByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_4217fc034801bec18f8d432ecd" ON "marketing_performance_snapshots" ("companyId", "campaignId", "periodEnd") `);
        await queryRunner.query(`CREATE TABLE "employee_marketing_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4dc4ead23563876660071b511d" ON "employee_marketing_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a8df6c1e9dbcdb6d4513e09daf" ON "employee_marketing_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a8df6c1e9dbcdb6d4513e09daf"`);
        await queryRunner.query(`DROP INDEX "IDX_4dc4ead23563876660071b511d"`);
        await queryRunner.query(`DROP TABLE "employee_marketing_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_4217fc034801bec18f8d432ecd"`);
        await queryRunner.query(`DROP TABLE "marketing_performance_snapshots"`);
        await queryRunner.query(`DROP INDEX "IDX_338ae942d06dbefb6791266291"`);
        await queryRunner.query(`DROP TABLE "marketing_experiments"`);
        await queryRunner.query(`DROP INDEX "IDX_f073065b36f1899c39000198c5"`);
        await queryRunner.query(`DROP INDEX "IDX_94b1f69e412d0aacf7724d0a69"`);
        await queryRunner.query(`DROP TABLE "marketing_creatives"`);
        await queryRunner.query(`DROP INDEX "IDX_86573e6c78285e31926428349d"`);
        await queryRunner.query(`DROP INDEX "IDX_4d9c9c053bb724e645a5b34f58"`);
        await queryRunner.query(`DROP INDEX "IDX_75ca47bbb4d25852ddea815431"`);
        await queryRunner.query(`DROP TABLE "marketing_campaigns"`);
    }

}
