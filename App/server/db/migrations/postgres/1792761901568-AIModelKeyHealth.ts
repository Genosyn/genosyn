import { MigrationInterface, QueryRunner } from "typeorm";

export class AIModelKeyHealth1792761901568 implements MigrationInterface {
    name = 'AIModelKeyHealth1792761901568'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_model_key_health" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "modelId" character varying NOT NULL, "keyId" character varying NOT NULL, "lastUsedAt" TIMESTAMP WITH TIME ZONE, "lastErrorAt" TIMESTAMP WITH TIME ZONE, "lastErrorStatus" integer, "lastErrorKind" character varying, "lastErrorMessage" character varying(300), "coolDownUntil" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d790de536e76190944d5fdcd1d0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0e7414b795846f418091f26414" ON "ai_model_key_health" ("modelId", "keyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_0e7414b795846f418091f26414"`);
        await queryRunner.query(`DROP TABLE "ai_model_key_health"`);
    }

}
