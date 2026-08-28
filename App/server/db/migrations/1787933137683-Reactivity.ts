import { MigrationInterface, QueryRunner } from "typeorm";

export class Reactivity1787933137683 implements MigrationInterface {
    name = 'Reactivity1787933137683'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_triggers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "routineId" varchar NOT NULL, "kind" varchar NOT NULL, "scopeId" varchar, "minIntervalSec" integer NOT NULL DEFAULT (900), "enabled" boolean NOT NULL DEFAULT (1), "lastFiredAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_b352d021fc841c5a17c78bd261" ON "routine_triggers" ("companyId", "kind") `);
        await queryRunner.query(`CREATE TABLE "employee_wakeups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "at" datetime NOT NULL, "brief" text NOT NULL DEFAULT (''), "sourceRunId" varchar, "sourceRoutineId" varchar, "status" varchar NOT NULL DEFAULT ('pending'), "firedAt" datetime, "outcomeNote" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_416737fca89fa5d5e9f6b65066" ON "employee_wakeups" ("status", "at") `);
        await queryRunner.query(`CREATE TABLE "workstreams" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "title" varchar NOT NULL, "objective" text NOT NULL DEFAULT (''), "stateDoc" text NOT NULL DEFAULT (''), "routineId" varchar, "status" varchar NOT NULL DEFAULT ('active'), "closeReason" text NOT NULL DEFAULT (''), "lastRunId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_055cc5b6d1121a4b039d06b3ab" ON "workstreams" ("companyId", "status") `);
        await queryRunner.query(`CREATE TABLE "initiatives" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "title" varchar NOT NULL, "evidence" text NOT NULL DEFAULT (''), "proposal" text NOT NULL DEFAULT (''), "routineSpecJson" text NOT NULL DEFAULT ('{}'), "status" varchar NOT NULL DEFAULT ('pending'), "decidedByUserId" varchar, "decidedAt" datetime, "reviewNote" text NOT NULL DEFAULT (''), "createdRoutineId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f6c9d4e308cd1988c22eaad69" ON "initiatives" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_2f6c9d4e308cd1988c22eaad69"`);
        await queryRunner.query(`DROP TABLE "initiatives"`);
        await queryRunner.query(`DROP INDEX "IDX_055cc5b6d1121a4b039d06b3ab"`);
        await queryRunner.query(`DROP TABLE "workstreams"`);
        await queryRunner.query(`DROP INDEX "IDX_416737fca89fa5d5e9f6b65066"`);
        await queryRunner.query(`DROP TABLE "employee_wakeups"`);
        await queryRunner.query(`DROP INDEX "IDX_b352d021fc841c5a17c78bd261"`);
        await queryRunner.query(`DROP TABLE "routine_triggers"`);
    }

}
