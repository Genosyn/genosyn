import { MigrationInterface, QueryRunner } from "typeorm";

export class ChartBaseSource1793106599575 implements MigrationInterface {
    name = 'ChartBaseSource1793106599575'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_04fdc19be6ac762b25e46882d2"`);
        await queryRunner.query(`DROP INDEX "IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`CREATE TABLE "temporary_charts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "connectionId" varchar NOT NULL, "sql" text NOT NULL DEFAULT (''), "vizType" varchar NOT NULL DEFAULT ('table'), "vizConfig" text NOT NULL DEFAULT ('{}'), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "baseId" varchar, "baseQueryJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_charts"("id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt" FROM "charts"`);
        await queryRunner.query(`DROP TABLE "charts"`);
        await queryRunner.query(`ALTER TABLE "temporary_charts" RENAME TO "charts"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04fdc19be6ac762b25e46882d2" ON "charts" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
        await queryRunner.query(`DROP INDEX "IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`DROP INDEX "IDX_04fdc19be6ac762b25e46882d2"`);
        await queryRunner.query(`CREATE TABLE "temporary_charts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "connectionId" varchar, "sql" text NOT NULL DEFAULT (''), "vizType" varchar NOT NULL DEFAULT ('table'), "vizConfig" text NOT NULL DEFAULT ('{}'), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "baseId" varchar, "baseQueryJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_charts"("id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt", "baseId", "baseQueryJson") SELECT "id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt", "baseId", "baseQueryJson" FROM "charts"`);
        await queryRunner.query(`DROP TABLE "charts"`);
        await queryRunner.query(`ALTER TABLE "temporary_charts" RENAME TO "charts"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04fdc19be6ac762b25e46882d2" ON "charts" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_a4b3f581766c791da14a40f8bd" ON "charts" ("companyId", "baseId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`DROP INDEX "IDX_a4b3f581766c791da14a40f8bd"`);
        await queryRunner.query(`DROP INDEX "IDX_04fdc19be6ac762b25e46882d2"`);
        await queryRunner.query(`ALTER TABLE "charts" RENAME TO "temporary_charts"`);
        await queryRunner.query(`CREATE TABLE "charts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "connectionId" varchar NOT NULL, "sql" text NOT NULL DEFAULT (''), "vizType" varchar NOT NULL DEFAULT ('table'), "vizConfig" text NOT NULL DEFAULT ('{}'), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "baseId" varchar, "baseQueryJson" text)`);
        await queryRunner.query(`INSERT INTO "charts"("id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt", "baseId", "baseQueryJson") SELECT "id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt", "baseId", "baseQueryJson" FROM "temporary_charts"`);
        await queryRunner.query(`DROP TABLE "temporary_charts"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04fdc19be6ac762b25e46882d2" ON "charts" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
        await queryRunner.query(`DROP INDEX "IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`DROP INDEX "IDX_04fdc19be6ac762b25e46882d2"`);
        await queryRunner.query(`ALTER TABLE "charts" RENAME TO "temporary_charts"`);
        await queryRunner.query(`CREATE TABLE "charts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "connectionId" varchar NOT NULL, "sql" text NOT NULL DEFAULT (''), "vizType" varchar NOT NULL DEFAULT ('table'), "vizConfig" text NOT NULL DEFAULT ('{}'), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "charts"("id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "description", "connectionId", "sql", "vizType", "vizConfig", "createdById", "createdByEmployeeId", "createdAt", "updatedAt" FROM "temporary_charts"`);
        await queryRunner.query(`DROP TABLE "temporary_charts"`);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_04fdc19be6ac762b25e46882d2" ON "charts" ("companyId", "slug") `);
    }

}
