import { MigrationInterface, QueryRunner } from "typeorm";

export class ModelRunConcurrency1790862603836 implements MigrationInterface {
    name = 'ModelRunConcurrency1790862603836'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer)`);
        await queryRunner.query(`INSERT INTO "temporary_ai_models"("id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource") SELECT "id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource" FROM "ai_models"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_models" RENAME TO "ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`ALTER TABLE "ai_models" RENAME TO "temporary_ai_models"`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar)`);
        await queryRunner.query(`INSERT INTO "ai_models"("id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource") SELECT "id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource" FROM "temporary_ai_models"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
    }

}
