import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Moves AI Models from company-owned to employee-owned (one-to-one), and
 * drops the now-redundant `defaultModelId` on employees and `modelId`
 * override on routines. Any existing model rows are dropped — this predates
 * a released version, so there's nothing to preserve.
 */
export class EmployeeOwnedModels1776250000000 implements MigrationInterface {
  name = "EmployeeOwnedModels1776250000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rebuild ai_models with the new shape. SQLite can't DROP COLUMN reliably
    // across versions, so we recreate. Existing rows are abandoned by design.
    await queryRunner.query(`DROP TABLE "ai_models"`);
    await queryRunner.query(
      `CREATE TABLE "ai_models" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "provider" varchar NOT NULL,
        "model" varchar NOT NULL,
        "authMode" varchar NOT NULL DEFAULT ('subscription'),
        "configJson" text NOT NULL DEFAULT ('{}'),
        "connectedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ai_models_employeeId" ON "ai_models" ("employeeId")`,
    );

    // Drop defaultModelId on ai_employees (SQLite: rebuild table).
    await queryRunner.query(
      `CREATE TABLE "ai_employees_new" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "role" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "ai_employees_new" ("id", "companyId", "name", "slug", "role", "createdAt")
       SELECT "id", "companyId", "name", "slug", "role", "createdAt" FROM "ai_employees"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ee8cf7de39f600c1d51250df21"`);
    await queryRunner.query(`DROP TABLE "ai_employees"`);
    await queryRunner.query(`ALTER TABLE "ai_employees_new" RENAME TO "ai_employees"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug")`,
    );

    // Drop modelId on routines (same rebuild dance).
    await queryRunner.query(
      `CREATE TABLE "routines_new" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "cronExpr" varchar NOT NULL,
        "enabled" boolean NOT NULL DEFAULT (1),
        "lastRunAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "routines_new" ("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt")
       SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt" FROM "routines"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_59e11503010aeeab1de06f89a9"`);
    await queryRunner.query(`DROP TABLE "routines"`);
    await queryRunner.query(`ALTER TABLE "routines_new" RENAME TO "routines"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: re-add modelId on routines, defaultModelId on ai_employees,
    // and put ai_models back on companyId.
    await queryRunner.query(`ALTER TABLE "routines" ADD COLUMN "modelId" varchar`);
    await queryRunner.query(`ALTER TABLE "ai_employees" ADD COLUMN "defaultModelId" varchar`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_models_employeeId"`);
    await queryRunner.query(`DROP TABLE "ai_models"`);
    await queryRunner.query(
      `CREATE TABLE "ai_models" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "provider" varchar NOT NULL,
        "model" varchar NOT NULL,
        "configJson" text NOT NULL DEFAULT ('{}'),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
  }
}
