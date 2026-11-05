import { MigrationInterface, QueryRunner } from "typeorm";

export class HelpCenter1793898259591 implements MigrationInterface {
    name = 'HelpCenter1793898259591'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5ce72101c56e73c64ca6f8b9a4"`);
        await queryRunner.query(`CREATE TABLE "temporary_support_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "aiEmployeeId" varchar, "nextTicketNumber" integer NOT NULL DEFAULT (1), "workingLanguage" varchar NOT NULL DEFAULT ('English'), "slaEnabled" boolean NOT NULL DEFAULT (1), "ratingsEnabled" boolean NOT NULL DEFAULT (0), "autoCloseDays" integer NOT NULL DEFAULT (7), "autoSolveDays" integer NOT NULL DEFAULT (5), "insightsAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "aiInstructions" text NOT NULL DEFAULT (''), "aiDisclosure" text, "topicsJson" text, "slaJson" text, "businessHoursJson" text, "insightsJson" text, "helpCenterEnabled" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_support_settings"("id", "companyId", "aiEmployeeId", "nextTicketNumber", "workingLanguage", "slaEnabled", "ratingsEnabled", "autoCloseDays", "autoSolveDays", "insightsAt", "createdAt", "updatedAt", "aiInstructions", "aiDisclosure", "topicsJson", "slaJson", "businessHoursJson", "insightsJson") SELECT "id", "companyId", "aiEmployeeId", "nextTicketNumber", "workingLanguage", "slaEnabled", "ratingsEnabled", "autoCloseDays", "autoSolveDays", "insightsAt", "createdAt", "updatedAt", "aiInstructions", "aiDisclosure", "topicsJson", "slaJson", "businessHoursJson", "insightsJson" FROM "support_settings"`);
        await queryRunner.query(`DROP TABLE "support_settings"`);
        await queryRunner.query(`ALTER TABLE "temporary_support_settings" RENAME TO "support_settings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5ce72101c56e73c64ca6f8b9a4" ON "support_settings" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_35525ac07b62f428da567ceaae" ON "support_articles" ("companyId", "status", "title", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_35525ac07b62f428da567ceaae"`);
        await queryRunner.query(`DROP INDEX "IDX_5ce72101c56e73c64ca6f8b9a4"`);
        await queryRunner.query(`ALTER TABLE "support_settings" RENAME TO "temporary_support_settings"`);
        await queryRunner.query(`CREATE TABLE "support_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "aiEmployeeId" varchar, "nextTicketNumber" integer NOT NULL DEFAULT (1), "workingLanguage" varchar NOT NULL DEFAULT ('English'), "slaEnabled" boolean NOT NULL DEFAULT (1), "ratingsEnabled" boolean NOT NULL DEFAULT (0), "autoCloseDays" integer NOT NULL DEFAULT (7), "autoSolveDays" integer NOT NULL DEFAULT (5), "insightsAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "aiInstructions" text NOT NULL DEFAULT (''), "aiDisclosure" text, "topicsJson" text, "slaJson" text, "businessHoursJson" text, "insightsJson" text)`);
        await queryRunner.query(`INSERT INTO "support_settings"("id", "companyId", "aiEmployeeId", "nextTicketNumber", "workingLanguage", "slaEnabled", "ratingsEnabled", "autoCloseDays", "autoSolveDays", "insightsAt", "createdAt", "updatedAt", "aiInstructions", "aiDisclosure", "topicsJson", "slaJson", "businessHoursJson", "insightsJson") SELECT "id", "companyId", "aiEmployeeId", "nextTicketNumber", "workingLanguage", "slaEnabled", "ratingsEnabled", "autoCloseDays", "autoSolveDays", "insightsAt", "createdAt", "updatedAt", "aiInstructions", "aiDisclosure", "topicsJson", "slaJson", "businessHoursJson", "insightsJson" FROM "temporary_support_settings"`);
        await queryRunner.query(`DROP TABLE "temporary_support_settings"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5ce72101c56e73c64ca6f8b9a4" ON "support_settings" ("companyId") `);
    }

}
