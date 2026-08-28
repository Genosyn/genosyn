import { MigrationInterface, QueryRunner } from "typeorm";

export class Reactivity1787933157859 implements MigrationInterface {
    name = 'Reactivity1787933157859'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_triggers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "routineId" character varying NOT NULL, "kind" character varying NOT NULL, "scopeId" character varying, "minIntervalSec" integer NOT NULL DEFAULT '900', "enabled" boolean NOT NULL DEFAULT true, "lastFiredAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7b8f7a9e679d56be4dac5b2005c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b352d021fc841c5a17c78bd261" ON "routine_triggers" ("companyId", "kind") `);
        await queryRunner.query(`CREATE TABLE "employee_wakeups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "at" TIMESTAMP WITH TIME ZONE NOT NULL, "brief" text NOT NULL DEFAULT '', "sourceRunId" character varying, "sourceRoutineId" character varying, "status" character varying NOT NULL DEFAULT 'pending', "firedAt" TIMESTAMP WITH TIME ZONE, "outcomeNote" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_59e0a99807399628934a3f630f4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_416737fca89fa5d5e9f6b65066" ON "employee_wakeups" ("status", "at") `);
        await queryRunner.query(`CREATE TABLE "workstreams" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "title" character varying NOT NULL, "objective" text NOT NULL DEFAULT '', "stateDoc" text NOT NULL DEFAULT '', "routineId" character varying, "status" character varying NOT NULL DEFAULT 'active', "closeReason" text NOT NULL DEFAULT '', "lastRunId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4537fd32f0afc72db3adc425806" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_055cc5b6d1121a4b039d06b3ab" ON "workstreams" ("companyId", "status") `);
        await queryRunner.query(`CREATE TABLE "initiatives" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "title" character varying NOT NULL, "evidence" text NOT NULL DEFAULT '', "proposal" text NOT NULL DEFAULT '', "routineSpecJson" text NOT NULL DEFAULT '{}', "status" character varying NOT NULL DEFAULT 'pending', "decidedByUserId" character varying, "decidedAt" TIMESTAMP WITH TIME ZONE, "reviewNote" text NOT NULL DEFAULT '', "createdRoutineId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6f2f191bc885b9c50400a8b10d8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f6c9d4e308cd1988c22eaad69" ON "initiatives" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_2f6c9d4e308cd1988c22eaad69"`);
        await queryRunner.query(`DROP TABLE "initiatives"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_055cc5b6d1121a4b039d06b3ab"`);
        await queryRunner.query(`DROP TABLE "workstreams"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_416737fca89fa5d5e9f6b65066"`);
        await queryRunner.query(`DROP TABLE "employee_wakeups"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b352d021fc841c5a17c78bd261"`);
        await queryRunner.query(`DROP TABLE "routine_triggers"`);
    }

}
