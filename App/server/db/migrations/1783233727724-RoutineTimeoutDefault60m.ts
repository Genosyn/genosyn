import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineTimeoutDefault60m1783233727724 implements MigrationInterface {
    name = 'RoutineTimeoutDefault60m1783233727724'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean)`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean)`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
    }

}
