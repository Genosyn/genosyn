import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyAIModels1792830643846 implements MigrationInterface {
    name = 'CompanyAIModels1792830643846'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_models" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "modelId" varchar NOT NULL, "isActive" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7d3963b3045cf65c5168303871" ON "employee_models" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5998eb10ba3a91b1c3d9f40280" ON "employee_models" ("modelId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_442355432f293fc03cae530da9" ON "employee_models" ("employeeId", "modelId") `);
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_ai_models"("id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns") SELECT "id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns" FROM "ai_models"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_models" RENAME TO "ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_ai_models"("id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "ai_models"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_models" RENAME TO "ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`ALTER TABLE "ai_models" RENAME TO "temporary_ai_models"`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar)`);
        await queryRunner.query(`INSERT INTO "ai_models"("id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "temporary_ai_models"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`ALTER TABLE "ai_models" RENAME TO "temporary_ai_models"`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer)`);
        await queryRunner.query(`INSERT INTO "ai_models"("id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns") SELECT "id", "employeeId", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "isActive", "contextWindow", "contextWindowSource", "maxConcurrentRuns" FROM "temporary_ai_models"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
        await queryRunner.query(`DROP INDEX "IDX_442355432f293fc03cae530da9"`);
        await queryRunner.query(`DROP INDEX "IDX_5998eb10ba3a91b1c3d9f40280"`);
        await queryRunner.query(`DROP INDEX "IDX_7d3963b3045cf65c5168303871"`);
        await queryRunner.query(`DROP TABLE "employee_models"`);
    }

}
