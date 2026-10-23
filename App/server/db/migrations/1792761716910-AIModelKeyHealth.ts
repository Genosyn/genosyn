import { MigrationInterface, QueryRunner } from "typeorm";

export class AIModelKeyHealth1792761716910 implements MigrationInterface {
    name = 'AIModelKeyHealth1792761716910'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_model_key_health" ("id" varchar PRIMARY KEY NOT NULL, "modelId" varchar NOT NULL, "keyId" varchar NOT NULL, "lastUsedAt" datetime, "lastErrorAt" datetime, "lastErrorStatus" integer, "lastErrorKind" varchar, "lastErrorMessage" varchar(300), "coolDownUntil" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0e7414b795846f418091f26414" ON "ai_model_key_health" ("modelId", "keyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0e7414b795846f418091f26414"`);
        await queryRunner.query(`DROP TABLE "ai_model_key_health"`);
    }

}
