import { MigrationInterface, QueryRunner } from "typeorm";

export class DashboardFormulaWidgets1789642545764 implements MigrationInterface {
    name = 'DashboardFormulaWidgets1789642545764'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ab44fdb49c60d0820faa28ae67"`);
        await queryRunner.query(`DROP INDEX "IDX_bf8dab799955c90603a0197bec"`);
        await queryRunner.query(`CREATE TABLE "temporary_dashboard_cards" ("id" varchar PRIMARY KEY NOT NULL, "dashboardId" varchar NOT NULL, "chartId" varchar NOT NULL, "x" integer NOT NULL DEFAULT (0), "y" integer NOT NULL DEFAULT (0), "w" integer NOT NULL DEFAULT (4), "h" integer NOT NULL DEFAULT (3), "titleOverride" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "formulaJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_dashboard_cards"("id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt") SELECT "id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt" FROM "dashboard_cards"`);
        await queryRunner.query(`DROP TABLE "dashboard_cards"`);
        await queryRunner.query(`ALTER TABLE "temporary_dashboard_cards" RENAME TO "dashboard_cards"`);
        await queryRunner.query(`CREATE INDEX "IDX_ab44fdb49c60d0820faa28ae67" ON "dashboard_cards" ("dashboardId") `);
        await queryRunner.query(`CREATE INDEX "IDX_bf8dab799955c90603a0197bec" ON "dashboard_cards" ("chartId") `);
        await queryRunner.query(`DROP INDEX "IDX_ab44fdb49c60d0820faa28ae67"`);
        await queryRunner.query(`DROP INDEX "IDX_bf8dab799955c90603a0197bec"`);
        await queryRunner.query(`CREATE TABLE "temporary_dashboard_cards" ("id" varchar PRIMARY KEY NOT NULL, "dashboardId" varchar NOT NULL, "chartId" varchar, "x" integer NOT NULL DEFAULT (0), "y" integer NOT NULL DEFAULT (0), "w" integer NOT NULL DEFAULT (4), "h" integer NOT NULL DEFAULT (3), "titleOverride" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "formulaJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_dashboard_cards"("id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt", "formulaJson") SELECT "id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt", "formulaJson" FROM "dashboard_cards"`);
        await queryRunner.query(`DROP TABLE "dashboard_cards"`);
        await queryRunner.query(`ALTER TABLE "temporary_dashboard_cards" RENAME TO "dashboard_cards"`);
        await queryRunner.query(`CREATE INDEX "IDX_ab44fdb49c60d0820faa28ae67" ON "dashboard_cards" ("dashboardId") `);
        await queryRunner.query(`CREATE INDEX "IDX_bf8dab799955c90603a0197bec" ON "dashboard_cards" ("chartId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_bf8dab799955c90603a0197bec"`);
        await queryRunner.query(`DROP INDEX "IDX_ab44fdb49c60d0820faa28ae67"`);
        await queryRunner.query(`ALTER TABLE "dashboard_cards" RENAME TO "temporary_dashboard_cards"`);
        await queryRunner.query(`CREATE TABLE "dashboard_cards" ("id" varchar PRIMARY KEY NOT NULL, "dashboardId" varchar NOT NULL, "chartId" varchar NOT NULL, "x" integer NOT NULL DEFAULT (0), "y" integer NOT NULL DEFAULT (0), "w" integer NOT NULL DEFAULT (4), "h" integer NOT NULL DEFAULT (3), "titleOverride" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "formulaJson" text)`);
        await queryRunner.query(`INSERT INTO "dashboard_cards"("id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt", "formulaJson") SELECT "id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt", "formulaJson" FROM "temporary_dashboard_cards"`);
        await queryRunner.query(`DROP TABLE "temporary_dashboard_cards"`);
        await queryRunner.query(`CREATE INDEX "IDX_bf8dab799955c90603a0197bec" ON "dashboard_cards" ("chartId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab44fdb49c60d0820faa28ae67" ON "dashboard_cards" ("dashboardId") `);
        await queryRunner.query(`DROP INDEX "IDX_bf8dab799955c90603a0197bec"`);
        await queryRunner.query(`DROP INDEX "IDX_ab44fdb49c60d0820faa28ae67"`);
        await queryRunner.query(`ALTER TABLE "dashboard_cards" RENAME TO "temporary_dashboard_cards"`);
        await queryRunner.query(`CREATE TABLE "dashboard_cards" ("id" varchar PRIMARY KEY NOT NULL, "dashboardId" varchar NOT NULL, "chartId" varchar NOT NULL, "x" integer NOT NULL DEFAULT (0), "y" integer NOT NULL DEFAULT (0), "w" integer NOT NULL DEFAULT (4), "h" integer NOT NULL DEFAULT (3), "titleOverride" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "dashboard_cards"("id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt") SELECT "id", "dashboardId", "chartId", "x", "y", "w", "h", "titleOverride", "createdAt", "updatedAt" FROM "temporary_dashboard_cards"`);
        await queryRunner.query(`DROP TABLE "temporary_dashboard_cards"`);
        await queryRunner.query(`CREATE INDEX "IDX_bf8dab799955c90603a0197bec" ON "dashboard_cards" ("chartId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab44fdb49c60d0820faa28ae67" ON "dashboard_cards" ("dashboardId") `);
    }

}
