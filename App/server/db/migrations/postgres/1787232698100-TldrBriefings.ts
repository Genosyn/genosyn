import { MigrationInterface, QueryRunner } from "typeorm";

export class TldrBriefings1787232698100 implements MigrationInterface {
    name = 'TldrBriefings1787232698100'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tldr_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying, "enabled" boolean NOT NULL DEFAULT false, "cadence" character varying NOT NULL DEFAULT 'daily', "nextRunAt" TIMESTAMP WITH TIME ZONE, "lastCoveredAt" TIMESTAMP WITH TIME ZONE, "lastGeneratedAt" TIMESTAMP WITH TIME ZONE, "lastAttemptAt" TIMESTAMP WITH TIME ZONE, "activeTldrId" character varying, "lastError" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_665e1888d8c11c60af95954b93b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_35c273326557b4efdb4cdf88de" ON "tldr_settings" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_86a5607ff2d5c0629b661f30cb" ON "tldr_settings" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "tldrs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying, "employeeName" character varying NOT NULL, "employeeSlug" character varying NOT NULL, "employeeRole" character varying NOT NULL, "employeeAvatarKey" character varying, "status" character varying NOT NULL DEFAULT 'generating', "triggerKind" character varying NOT NULL DEFAULT 'schedule', "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL, "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL, "title" character varying NOT NULL DEFAULT '', "summary" text NOT NULL DEFAULT '', "body" text NOT NULL DEFAULT '', "sourceStatsJson" text NOT NULL DEFAULT '{}', "errorMessage" text NOT NULL DEFAULT '', "finishedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2666801392e7de8ee9ac379dcba" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_3cfd2f67b3de018b2602fc3d5a" ON "tldrs" ("companyId", "periodStart", "periodEnd") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3307821b3acc9331199d8cef7" ON "tldrs" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "tldr_dismissals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "tldrId" character varying NOT NULL, "userId" character varying NOT NULL, "dismissedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4b9e537ed3d59223c7941da1b71" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_8da123fb1bcb6f6dcd83d18df3" ON "tldr_dismissals" ("companyId", "userId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fa3bcecfd4b643cab85f5b094d" ON "tldr_dismissals" ("tldrId", "userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_fa3bcecfd4b643cab85f5b094d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8da123fb1bcb6f6dcd83d18df3"`);
        await queryRunner.query(`DROP TABLE "tldr_dismissals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e3307821b3acc9331199d8cef7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3cfd2f67b3de018b2602fc3d5a"`);
        await queryRunner.query(`DROP TABLE "tldrs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_86a5607ff2d5c0629b661f30cb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_35c273326557b4efdb4cdf88de"`);
        await queryRunner.query(`DROP TABLE "tldr_settings"`);
    }

}
