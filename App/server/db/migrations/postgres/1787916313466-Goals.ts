import { MigrationInterface, QueryRunner } from "typeorm";

export class Goals1787916313466 implements MigrationInterface {
    name = 'Goals1787916313466'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "goals" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "title" character varying NOT NULL, "slug" character varying NOT NULL, "description" text NOT NULL DEFAULT '', "parentGoalId" character varying, "ownerEmployeeId" character varying, "metricKind" character varying NOT NULL DEFAULT 'manual', "chartId" character varying, "startValue" real, "targetValue" real NOT NULL, "currentValue" real, "currentValueUpdatedAt" TIMESTAMP WITH TIME ZONE, "direction" character varying NOT NULL DEFAULT 'increase_to', "unit" character varying NOT NULL DEFAULT '', "dueAt" TIMESTAMP WITH TIME ZONE, "status" character varying NOT NULL DEFAULT 'active', "settledAt" TIMESTAMP WITH TIME ZONE, "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_26e17b251afab35580dff769223" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1087ee67d19c93aacd15308671" ON "goals" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_18be48306abc4a617bf9eac79a" ON "goals" ("companyId", "slug") `);
        await queryRunner.query(`ALTER TABLE "routines" ADD "goalId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "goalId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_18be48306abc4a617bf9eac79a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1087ee67d19c93aacd15308671"`);
        await queryRunner.query(`DROP TABLE "goals"`);
    }

}
