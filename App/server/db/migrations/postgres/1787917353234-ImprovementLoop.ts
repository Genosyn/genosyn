import { MigrationInterface, QueryRunner } from "typeorm";

export class ImprovementLoop1787917353234 implements MigrationInterface {
    name = 'ImprovementLoop1787917353234'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "run_lessons" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "routineId" character varying, "runId" character varying NOT NULL, "cause" text NOT NULL DEFAULT '', "advice" text NOT NULL DEFAULT '', "dismissedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_52da42ee1db8cbbf0cf88a0caa9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ff58ada8af485bc416c4477aef" ON "run_lessons" ("routineId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_d042e8d75869b9ab2e96199f07" ON "run_lessons" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "revision_proposals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "kind" character varying NOT NULL, "targetId" character varying, "targetLabel" character varying NOT NULL DEFAULT '', "baseBody" text NOT NULL DEFAULT '', "proposedBody" text NOT NULL DEFAULT '', "rationale" text NOT NULL DEFAULT '', "evidenceRunIdsJson" text NOT NULL DEFAULT '[]', "status" character varying NOT NULL DEFAULT 'pending', "errorMessage" text NOT NULL DEFAULT '', "decidedAt" TIMESTAMP WITH TIME ZONE, "decidedByUserId" character varying, "reviewNote" text NOT NULL DEFAULT '', "stallRemindedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_972bf38808acdacab5affa45f2a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_27b735e6b03ac1d5e60623f720" ON "revision_proposals" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_27b735e6b03ac1d5e60623f720"`);
        await queryRunner.query(`DROP TABLE "revision_proposals"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d042e8d75869b9ab2e96199f07"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ff58ada8af485bc416c4477aef"`);
        await queryRunner.query(`DROP TABLE "run_lessons"`);
    }

}
