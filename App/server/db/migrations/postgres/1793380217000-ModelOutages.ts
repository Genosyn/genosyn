import { MigrationInterface, QueryRunner } from "typeorm";

export class ModelOutages1793380217000 implements MigrationInterface {
    name = 'ModelOutages1793380217000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_model_outages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying NOT NULL, "companyId" character varying NOT NULL, "modelId" character varying NOT NULL, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endedAt" TIMESTAMP WITH TIME ZONE, "recoveredBy" character varying, "cause" character varying NOT NULL, "lastError" character varying(300) NOT NULL, "lastStatus" integer, "checks" integer NOT NULL DEFAULT '0', "lastCheckedAt" TIMESTAMP WITH TIME ZONE, "nextCheckAt" TIMESTAMP WITH TIME ZONE NOT NULL, "notifiedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f3aa6bce8baffa50e1433f3f188" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_01af90b43afc9262c3dce4841e" ON "ai_model_outages" ("companyId", "startedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b192b332a5c87dfb1a708d09e0" ON "ai_model_outages" ("key") WHERE "endedAt" IS NULL`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "pauseReason" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "outagePauses" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "outagePauses"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "pauseReason"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b192b332a5c87dfb1a708d09e0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_01af90b43afc9262c3dce4841e"`);
        await queryRunner.query(`DROP TABLE "ai_model_outages"`);
    }

}
