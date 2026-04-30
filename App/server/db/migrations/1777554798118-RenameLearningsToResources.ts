import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Rename M18's "Learnings" feature to "Resources" — see ROADMAP.md and the
 * `Resource` entity for the full story. The old `learnings` and
 * `employee_learning_grants` tables are dropped (and any rows in them are
 * lost; the feature is days old, no install carries production data) and
 * fresh `resources` and `employee_resource_grants` tables are created.
 *
 * The CREATE block below was emitted by `migration:generate`. The DROP
 * block at the top is added by hand because TypeORM only diffs against
 * declared entities — it doesn't know about orphaned tables that no
 * entity points at any more.
 */
export class RenameLearningsToResources1777554798118 implements MigrationInterface {
    name = 'RenameLearningsToResources1777554798118'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Drop the old M18 "Learnings" tables and their indexes. The hashed
        // index names match what the M18 migration created.
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_76666070ddf36fd1f3ee6316b0"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_69b8b1f5be86152a92698eda85"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_aa67e2f19cf2719d133a9057bd"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "employee_learning_grants"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_5968fa55352eb5a71f45f02323"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_0e31b3a842bb3bfc9eb2b00f14"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "learnings"`);

        // Fresh "Resources" tables (auto-generated diff).
        await queryRunner.query(`CREATE TABLE "resources" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "sourceKind" varchar NOT NULL DEFAULT ('url'), "sourceUrl" varchar, "sourceFilename" varchar, "storageKey" varchar, "summary" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "tags" varchar NOT NULL DEFAULT (''), "bytes" bigint NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('pending'), "errorMessage" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7e67e70759a1a595641031a8d4" ON "resources" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6b45e2ff392972158a306f0fbc" ON "resources" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "employee_resource_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "resourceId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_199a481acc6c94c487097bdaa3" ON "employee_resource_grants" ("employeeId", "resourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a67558128d298c6dd78e478601" ON "employee_resource_grants" ("resourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_07191e9a92b46bafc94513ffd7" ON "employee_resource_grants" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop the new "Resources" tables (auto-generated reverse).
        await queryRunner.query(`DROP INDEX "IDX_07191e9a92b46bafc94513ffd7"`);
        await queryRunner.query(`DROP INDEX "IDX_a67558128d298c6dd78e478601"`);
        await queryRunner.query(`DROP INDEX "IDX_199a481acc6c94c487097bdaa3"`);
        await queryRunner.query(`DROP TABLE "employee_resource_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_6b45e2ff392972158a306f0fbc"`);
        await queryRunner.query(`DROP INDEX "IDX_7e67e70759a1a595641031a8d4"`);
        await queryRunner.query(`DROP TABLE "resources"`);

        // Re-create the old "Learnings" tables to match the M18 migration.
        await queryRunner.query(`CREATE TABLE "learnings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "sourceKind" varchar NOT NULL DEFAULT ('url'), "sourceUrl" varchar, "sourceFilename" varchar, "storageKey" varchar, "summary" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "tags" varchar NOT NULL DEFAULT (''), "bytes" bigint NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('pending'), "errorMessage" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_0e31b3a842bb3bfc9eb2b00f14" ON "learnings" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5968fa55352eb5a71f45f02323" ON "learnings" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "employee_learning_grants" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "learningId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_aa67e2f19cf2719d133a9057bd" ON "employee_learning_grants" ("employeeId", "learningId") `);
        await queryRunner.query(`CREATE INDEX "IDX_69b8b1f5be86152a92698eda85" ON "employee_learning_grants" ("learningId") `);
        await queryRunner.query(`CREATE INDEX "IDX_76666070ddf36fd1f3ee6316b0" ON "employee_learning_grants" ("employeeId") `);
    }

}
