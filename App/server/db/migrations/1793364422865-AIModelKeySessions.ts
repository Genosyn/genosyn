import { MigrationInterface, QueryRunner } from "typeorm";

export class AIModelKeySessions1793364422865 implements MigrationInterface {
    name = 'AIModelKeySessions1793364422865'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0e7414b795846f418091f26414"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_model_key_health" ("id" varchar PRIMARY KEY NOT NULL, "modelId" varchar NOT NULL, "keyId" varchar NOT NULL, "lastUsedAt" datetime, "lastErrorAt" datetime, "lastErrorStatus" integer, "lastErrorKind" varchar, "lastErrorMessage" varchar(300), "coolDownUntil" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "sessionsByHour" text)`);
        await queryRunner.query(`INSERT INTO "temporary_ai_model_key_health"("id", "modelId", "keyId", "lastUsedAt", "lastErrorAt", "lastErrorStatus", "lastErrorKind", "lastErrorMessage", "coolDownUntil", "createdAt") SELECT "id", "modelId", "keyId", "lastUsedAt", "lastErrorAt", "lastErrorStatus", "lastErrorKind", "lastErrorMessage", "coolDownUntil", "createdAt" FROM "ai_model_key_health"`);
        await queryRunner.query(`DROP TABLE "ai_model_key_health"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_model_key_health" RENAME TO "ai_model_key_health"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0e7414b795846f418091f26414" ON "ai_model_key_health" ("modelId", "keyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0e7414b795846f418091f26414"`);
        await queryRunner.query(`ALTER TABLE "ai_model_key_health" RENAME TO "temporary_ai_model_key_health"`);
        await queryRunner.query(`CREATE TABLE "ai_model_key_health" ("id" varchar PRIMARY KEY NOT NULL, "modelId" varchar NOT NULL, "keyId" varchar NOT NULL, "lastUsedAt" datetime, "lastErrorAt" datetime, "lastErrorStatus" integer, "lastErrorKind" varchar, "lastErrorMessage" varchar(300), "coolDownUntil" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "ai_model_key_health"("id", "modelId", "keyId", "lastUsedAt", "lastErrorAt", "lastErrorStatus", "lastErrorKind", "lastErrorMessage", "coolDownUntil", "createdAt") SELECT "id", "modelId", "keyId", "lastUsedAt", "lastErrorAt", "lastErrorStatus", "lastErrorKind", "lastErrorMessage", "coolDownUntil", "createdAt" FROM "temporary_ai_model_key_health"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_model_key_health"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0e7414b795846f418091f26414" ON "ai_model_key_health" ("modelId", "keyId") `);
    }

}
