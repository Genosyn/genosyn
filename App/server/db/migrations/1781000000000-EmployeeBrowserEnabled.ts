import { MigrationInterface, QueryRunner } from "typeorm";

export class EmployeeBrowserEnabled1781000000000 implements MigrationInterface {
    name = 'EmployeeBrowserEnabled1781000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "soulBody" text NOT NULL DEFAULT (''), "avatarKey" varchar, "teamId" varchar, "reportsToEmployeeId" varchar, "reportsToUserId" varchar, "browserEnabled" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_ai_employees"("id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId") SELECT "id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId" FROM "ai_employees"`);
        await queryRunner.query(`DROP TABLE "ai_employees"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_employees" RENAME TO "ai_employees"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`ALTER TABLE "ai_employees" RENAME TO "temporary_ai_employees"`);
        await queryRunner.query(`CREATE TABLE "ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "soulBody" text NOT NULL DEFAULT (''), "avatarKey" varchar, "teamId" varchar, "reportsToEmployeeId" varchar, "reportsToUserId" varchar)`);
        await queryRunner.query(`INSERT INTO "ai_employees"("id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId") SELECT "id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "reportsToEmployeeId", "reportsToUserId" FROM "temporary_ai_employees"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_employees"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
    }

}
