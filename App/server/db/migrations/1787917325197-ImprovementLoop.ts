import { MigrationInterface, QueryRunner } from "typeorm";

export class ImprovementLoop1787917325197 implements MigrationInterface {
    name = 'ImprovementLoop1787917325197'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "run_lessons" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "routineId" varchar, "runId" varchar NOT NULL, "cause" text NOT NULL DEFAULT (''), "advice" text NOT NULL DEFAULT (''), "dismissedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_ff58ada8af485bc416c4477aef" ON "run_lessons" ("routineId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_d042e8d75869b9ab2e96199f07" ON "run_lessons" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "revision_proposals" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "kind" varchar NOT NULL, "targetId" varchar, "targetLabel" varchar NOT NULL DEFAULT (''), "baseBody" text NOT NULL DEFAULT (''), "proposedBody" text NOT NULL DEFAULT (''), "rationale" text NOT NULL DEFAULT (''), "evidenceRunIdsJson" text NOT NULL DEFAULT ('[]'), "status" varchar NOT NULL DEFAULT ('pending'), "errorMessage" text NOT NULL DEFAULT (''), "decidedAt" datetime, "decidedByUserId" varchar, "reviewNote" text NOT NULL DEFAULT (''), "stallRemindedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_27b735e6b03ac1d5e60623f720" ON "revision_proposals" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_27b735e6b03ac1d5e60623f720"`);
        await queryRunner.query(`DROP TABLE "revision_proposals"`);
        await queryRunner.query(`DROP INDEX "IDX_d042e8d75869b9ab2e96199f07"`);
        await queryRunner.query(`DROP INDEX "IDX_ff58ada8af485bc416c4477aef"`);
        await queryRunner.query(`DROP TABLE "run_lessons"`);
    }

}
