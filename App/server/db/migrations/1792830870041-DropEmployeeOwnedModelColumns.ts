import { MigrationInterface, QueryRunner } from "typeorm";

export class DropEmployeeOwnedModelColumns1792830870041 implements MigrationInterface {
    name = 'DropEmployeeOwnedModelColumns1792830870041'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_models" ("id" varchar PRIMARY KEY NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_ai_models"("id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "ai_models"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_models" RENAME TO "ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_models" ("id" varchar PRIMARY KEY NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar NOT NULL)`);
        await queryRunner.query(`INSERT INTO "temporary_ai_models"("id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "ai_models"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_models" RENAME TO "ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`ALTER TABLE "ai_models" RENAME TO "temporary_ai_models"`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar)`);
        await queryRunner.query(`INSERT INTO "ai_models"("id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "temporary_ai_models"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_b3ddf2975d84d9c12d8d54bf24"`);
        await queryRunner.query(`ALTER TABLE "ai_models" RENAME TO "temporary_ai_models"`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar, "provider" varchar NOT NULL, "model" varchar NOT NULL, "authMode" varchar NOT NULL DEFAULT ('apikey'), "configJson" text NOT NULL DEFAULT ('{}'), "connectedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "isActive" boolean NOT NULL DEFAULT (0), "contextWindow" integer, "contextWindowSource" varchar, "maxConcurrentRuns" integer, "companyId" varchar)`);
        await queryRunner.query(`INSERT INTO "ai_models"("id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId") SELECT "id", "provider", "model", "authMode", "configJson", "connectedAt", "createdAt", "contextWindow", "contextWindowSource", "maxConcurrentRuns", "companyId" FROM "temporary_ai_models"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_models"`);
        await queryRunner.query(`CREATE INDEX "IDX_b3ddf2975d84d9c12d8d54bf24" ON "ai_models" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
    }

}
