import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveReportingLines1791278784463 implements MigrationInterface {
    name = 'RemoveReportingLines1791278784463'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`CREATE TABLE "temporary_ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "soulBody" text NOT NULL DEFAULT (''), "avatarKey" varchar, "teamId" varchar, "browserEnabled" boolean NOT NULL DEFAULT (0), "browserAllowedHosts" text, "browserApprovalRequired" boolean NOT NULL DEFAULT (1))`);
        await queryRunner.query(`INSERT INTO "temporary_ai_employees"("id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "browserEnabled", "browserAllowedHosts", "browserApprovalRequired") SELECT "id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "browserEnabled", "browserAllowedHosts", "browserApprovalRequired" FROM "ai_employees"`);
        await queryRunner.query(`DROP TABLE "ai_employees"`);
        await queryRunner.query(`ALTER TABLE "temporary_ai_employees" RENAME TO "ai_employees"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_4d5d68b8f4d393441c6d48ae37"`);
        await queryRunner.query(`CREATE TABLE "temporary_decision_policies" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "askingEmployeeId" varchar, "deciderKind" varchar NOT NULL DEFAULT ('employee'), "deciderEmployeeId" varchar, "sortOrder" integer NOT NULL DEFAULT (0), "enabled" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "temporary_decision_policies"("id", "companyId", "askingEmployeeId", "deciderKind", "deciderEmployeeId", "sortOrder", "enabled", "createdAt", "updatedAt") SELECT "id", "companyId", "askingEmployeeId", "deciderKind", "deciderEmployeeId", "sortOrder", "enabled", "createdAt", "updatedAt" FROM "decision_policies"`);
        await queryRunner.query(`DROP TABLE "decision_policies"`);
        await queryRunner.query(`ALTER TABLE "temporary_decision_policies" RENAME TO "decision_policies"`);
        await queryRunner.query(`CREATE INDEX "IDX_4d5d68b8f4d393441c6d48ae37" ON "decision_policies" ("companyId", "enabled") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_4d5d68b8f4d393441c6d48ae37"`);
        await queryRunner.query(`ALTER TABLE "decision_policies" RENAME TO "temporary_decision_policies"`);
        await queryRunner.query(`CREATE TABLE "decision_policies" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "askingEmployeeId" varchar, "deciderKind" varchar NOT NULL DEFAULT ('manager'), "deciderEmployeeId" varchar, "sortOrder" integer NOT NULL DEFAULT (0), "enabled" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "decision_policies"("id", "companyId", "askingEmployeeId", "deciderKind", "deciderEmployeeId", "sortOrder", "enabled", "createdAt", "updatedAt") SELECT "id", "companyId", "askingEmployeeId", "deciderKind", "deciderEmployeeId", "sortOrder", "enabled", "createdAt", "updatedAt" FROM "temporary_decision_policies"`);
        await queryRunner.query(`DROP TABLE "temporary_decision_policies"`);
        await queryRunner.query(`CREATE INDEX "IDX_4d5d68b8f4d393441c6d48ae37" ON "decision_policies" ("companyId", "enabled") `);
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`ALTER TABLE "ai_employees" RENAME TO "temporary_ai_employees"`);
        await queryRunner.query(`CREATE TABLE "ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "soulBody" text NOT NULL DEFAULT (''), "avatarKey" varchar, "teamId" varchar, "reportsToEmployeeId" varchar, "reportsToUserId" varchar, "browserEnabled" boolean NOT NULL DEFAULT (0), "browserAllowedHosts" text, "browserApprovalRequired" boolean NOT NULL DEFAULT (1))`);
        await queryRunner.query(`INSERT INTO "ai_employees"("id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "browserEnabled", "browserAllowedHosts", "browserApprovalRequired") SELECT "id", "companyId", "name", "slug", "role", "createdAt", "soulBody", "avatarKey", "teamId", "browserEnabled", "browserAllowedHosts", "browserApprovalRequired" FROM "temporary_ai_employees"`);
        await queryRunner.query(`DROP TABLE "temporary_ai_employees"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
    }

}
