import { MigrationInterface, QueryRunner } from "typeorm";

export class GoalValueSource1791919721041 implements MigrationInterface {
    name = 'GoalValueSource1791919721041'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_18be48306abc4a617bf9eac79a"`);
        await queryRunner.query(`DROP INDEX "IDX_1087ee67d19c93aacd15308671"`);
        await queryRunner.query(`CREATE TABLE "temporary_goals" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "parentGoalId" varchar, "ownerEmployeeId" varchar, "metricKind" varchar NOT NULL DEFAULT ('manual'), "chartId" varchar, "startValue" real, "targetValue" real NOT NULL, "currentValue" real, "currentValueUpdatedAt" datetime, "direction" varchar NOT NULL DEFAULT ('increase_to'), "unit" varchar NOT NULL DEFAULT (''), "dueAt" datetime, "status" varchar NOT NULL DEFAULT ('active'), "settledAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "currentValueSource" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_goals"("id", "companyId", "title", "slug", "description", "parentGoalId", "ownerEmployeeId", "metricKind", "chartId", "startValue", "targetValue", "currentValue", "currentValueUpdatedAt", "direction", "unit", "dueAt", "status", "settledAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "description", "parentGoalId", "ownerEmployeeId", "metricKind", "chartId", "startValue", "targetValue", "currentValue", "currentValueUpdatedAt", "direction", "unit", "dueAt", "status", "settledAt", "createdById", "createdAt", "updatedAt" FROM "goals"`);
        await queryRunner.query(`DROP TABLE "goals"`);
        await queryRunner.query(`ALTER TABLE "temporary_goals" RENAME TO "goals"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_18be48306abc4a617bf9eac79a" ON "goals" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_1087ee67d19c93aacd15308671" ON "goals" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_1087ee67d19c93aacd15308671"`);
        await queryRunner.query(`DROP INDEX "IDX_18be48306abc4a617bf9eac79a"`);
        await queryRunner.query(`ALTER TABLE "goals" RENAME TO "temporary_goals"`);
        await queryRunner.query(`CREATE TABLE "goals" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "parentGoalId" varchar, "ownerEmployeeId" varchar, "metricKind" varchar NOT NULL DEFAULT ('manual'), "chartId" varchar, "startValue" real, "targetValue" real NOT NULL, "currentValue" real, "currentValueUpdatedAt" datetime, "direction" varchar NOT NULL DEFAULT ('increase_to'), "unit" varchar NOT NULL DEFAULT (''), "dueAt" datetime, "status" varchar NOT NULL DEFAULT ('active'), "settledAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "goals"("id", "companyId", "title", "slug", "description", "parentGoalId", "ownerEmployeeId", "metricKind", "chartId", "startValue", "targetValue", "currentValue", "currentValueUpdatedAt", "direction", "unit", "dueAt", "status", "settledAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "description", "parentGoalId", "ownerEmployeeId", "metricKind", "chartId", "startValue", "targetValue", "currentValue", "currentValueUpdatedAt", "direction", "unit", "dueAt", "status", "settledAt", "createdById", "createdAt", "updatedAt" FROM "temporary_goals"`);
        await queryRunner.query(`DROP TABLE "temporary_goals"`);
        await queryRunner.query(`CREATE INDEX "IDX_1087ee67d19c93aacd15308671" ON "goals" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_18be48306abc4a617bf9eac79a" ON "goals" ("companyId", "slug") `);
    }

}
