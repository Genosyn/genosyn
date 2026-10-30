import { MigrationInterface, QueryRunner } from "typeorm";

export class ModelWaits1793398935112 implements MigrationInterface {
    name = 'ModelWaits1793398935112'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_model_waits" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "kind" character varying NOT NULL, "targetId" character varying NOT NULL, "groupKey" character varying, "employeeId" character varying NOT NULL, "modelId" character varying, "status" character varying NOT NULL DEFAULT 'waiting', "attempts" integer NOT NULL DEFAULT '0', "resumeAt" TIMESTAMP WITH TIME ZONE NOT NULL, "claimedUntil" TIMESTAMP WITH TIME ZONE, "payloadJson" text NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8c879ba6e12a16b29cb1cb62cf5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1988c828d4fe0b5f5ba84245cb" ON "ai_model_waits" ("kind", "groupKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_0c226473e172c35871b5809169" ON "ai_model_waits" ("companyId", "modelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6d7e065055c29bdc48c7337ef1" ON "ai_model_waits" ("status", "resumeAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0bf43e576afc49d0b5d7fa0a78" ON "ai_model_waits" ("kind", "targetId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_0bf43e576afc49d0b5d7fa0a78"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6d7e065055c29bdc48c7337ef1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0c226473e172c35871b5809169"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1988c828d4fe0b5f5ba84245cb"`);
        await queryRunner.query(`DROP TABLE "ai_model_waits"`);
    }

}
