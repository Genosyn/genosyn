import { MigrationInterface, QueryRunner } from "typeorm";

export class DashboardLinks1794141811216 implements MigrationInterface {
    name = 'DashboardLinks1794141811216'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5d047d00801362457bea3e7dcb"`);
        await queryRunner.query(`CREATE TABLE "temporary_dashboards" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "linkTokenHash" varchar, "linkTokenEncrypted" text, "linkEnabledAt" datetime, "linkEnabledById" varchar, "linkRefreshSeconds" integer NOT NULL DEFAULT (300))`);
        await queryRunner.query(`INSERT INTO "temporary_dashboards"("id", "companyId", "title", "slug", "description", "createdById", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "description", "createdById", "createdByEmployeeId", "createdAt", "updatedAt" FROM "dashboards"`);
        await queryRunner.query(`DROP TABLE "dashboards"`);
        await queryRunner.query(`ALTER TABLE "temporary_dashboards" RENAME TO "dashboards"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5d047d00801362457bea3e7dcb" ON "dashboards" ("companyId", "slug") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b58272ad2514dc1f7753a24f20" ON "dashboards" ("linkTokenHash") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b58272ad2514dc1f7753a24f20"`);
        await queryRunner.query(`DROP INDEX "IDX_5d047d00801362457bea3e7dcb"`);
        await queryRunner.query(`ALTER TABLE "dashboards" RENAME TO "temporary_dashboards"`);
        await queryRunner.query(`CREATE TABLE "dashboards" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "dashboards"("id", "companyId", "title", "slug", "description", "createdById", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "description", "createdById", "createdByEmployeeId", "createdAt", "updatedAt" FROM "temporary_dashboards"`);
        await queryRunner.query(`DROP TABLE "temporary_dashboards"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5d047d00801362457bea3e7dcb" ON "dashboards" ("companyId", "slug") `);
    }

}
