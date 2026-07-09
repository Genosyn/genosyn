import { MigrationInterface, QueryRunner } from "typeorm";

export class M20Explore1781400000000 implements MigrationInterface {
    name = 'M20Explore1781400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "charts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "connectionId" varchar NOT NULL, "sql" text NOT NULL DEFAULT (''), "vizType" varchar NOT NULL DEFAULT ('table'), "vizConfig" text NOT NULL DEFAULT ('{}'), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04fdc19be6ac762b25e46882d2" ON "charts" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "dashboards" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5d047d00801362457bea3e7dcb" ON "dashboards" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "dashboard_cards" ("id" varchar PRIMARY KEY NOT NULL, "dashboardId" varchar NOT NULL, "chartId" varchar NOT NULL, "x" integer NOT NULL DEFAULT (0), "y" integer NOT NULL DEFAULT (0), "w" integer NOT NULL DEFAULT (4), "h" integer NOT NULL DEFAULT (3), "titleOverride" varchar NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_bf8dab799955c90603a0197bec" ON "dashboard_cards" ("chartId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab44fdb49c60d0820faa28ae67" ON "dashboard_cards" ("dashboardId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ab44fdb49c60d0820faa28ae67"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_bf8dab799955c90603a0197bec"`);
        await queryRunner.query(`DROP TABLE "dashboard_cards"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_5d047d00801362457bea3e7dcb"`);
        await queryRunner.query(`DROP TABLE "dashboards"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_04fdc19be6ac762b25e46882d2"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`DROP TABLE "charts"`);
    }

}
