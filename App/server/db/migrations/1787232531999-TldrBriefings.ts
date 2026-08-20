import { MigrationInterface, QueryRunner } from "typeorm";

export class TldrBriefings1787232531999 implements MigrationInterface {
    name = 'TldrBriefings1787232531999'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tldr_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar, "enabled" boolean NOT NULL DEFAULT (0), "cadence" varchar NOT NULL DEFAULT ('daily'), "nextRunAt" datetime, "lastCoveredAt" datetime, "lastGeneratedAt" datetime, "lastAttemptAt" datetime, "activeTldrId" varchar, "lastError" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_35c273326557b4efdb4cdf88de" ON "tldr_settings" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_86a5607ff2d5c0629b661f30cb" ON "tldr_settings" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "tldrs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar, "employeeName" varchar NOT NULL, "employeeSlug" varchar NOT NULL, "employeeRole" varchar NOT NULL, "employeeAvatarKey" varchar, "status" varchar NOT NULL DEFAULT ('generating'), "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "periodStart" datetime NOT NULL, "periodEnd" datetime NOT NULL, "title" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "body" text NOT NULL DEFAULT (''), "sourceStatsJson" text NOT NULL DEFAULT ('{}'), "errorMessage" text NOT NULL DEFAULT (''), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_3cfd2f67b3de018b2602fc3d5a" ON "tldrs" ("companyId", "periodStart", "periodEnd") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3307821b3acc9331199d8cef7" ON "tldrs" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "tldr_dismissals" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "userId" varchar NOT NULL, "dismissedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_8da123fb1bcb6f6dcd83d18df3" ON "tldr_dismissals" ("companyId", "userId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fa3bcecfd4b643cab85f5b094d" ON "tldr_dismissals" ("tldrId", "userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_fa3bcecfd4b643cab85f5b094d"`);
        await queryRunner.query(`DROP INDEX "IDX_8da123fb1bcb6f6dcd83d18df3"`);
        await queryRunner.query(`DROP TABLE "tldr_dismissals"`);
        await queryRunner.query(`DROP INDEX "IDX_e3307821b3acc9331199d8cef7"`);
        await queryRunner.query(`DROP INDEX "IDX_3cfd2f67b3de018b2602fc3d5a"`);
        await queryRunner.query(`DROP TABLE "tldrs"`);
        await queryRunner.query(`DROP INDEX "IDX_86a5607ff2d5c0629b661f30cb"`);
        await queryRunner.query(`DROP INDEX "IDX_35c273326557b4efdb4cdf88de"`);
        await queryRunner.query(`DROP TABLE "tldr_settings"`);
    }

}
