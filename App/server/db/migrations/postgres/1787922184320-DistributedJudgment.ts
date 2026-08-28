import { MigrationInterface, QueryRunner } from "typeorm";

export class DistributedJudgment1787922184320 implements MigrationInterface {
    name = 'DistributedJudgment1787922184320'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "decision_policies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "askingEmployeeId" character varying, "deciderKind" character varying NOT NULL DEFAULT 'manager', "deciderEmployeeId" character varying, "sortOrder" integer NOT NULL DEFAULT '0', "enabled" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c047eacc47a39fb3f97f9a483d3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4d5d68b8f4d393441c6d48ae37" ON "decision_policies" ("companyId", "enabled") `);
        await queryRunner.query(`CREATE TABLE "autonomy_waivers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "kind" character varying NOT NULL, "routineId" character varying, "grantedByUserId" character varying, "evidence" text NOT NULL DEFAULT '', "revokedAt" TIMESTAMP WITH TIME ZONE, "revokedReason" text NOT NULL DEFAULT '', "grantedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_134d4f0b53379ee21b2b91e1047" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_71225369d4930747d17a9eda2c" ON "autonomy_waivers" ("companyId", "employeeId") `);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "decidedByEmployeeId" character varying`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "routedToEmployeeId" character varying`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "routedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "routedAt"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "routedToEmployeeId"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "decidedByEmployeeId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_71225369d4930747d17a9eda2c"`);
        await queryRunner.query(`DROP TABLE "autonomy_waivers"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4d5d68b8f4d393441c6d48ae37"`);
        await queryRunner.query(`DROP TABLE "decision_policies"`);
    }

}
