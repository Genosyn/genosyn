import { MigrationInterface, QueryRunner } from "typeorm";

export class BrowserLiveViewAndDropBrowserbase1781200000000 implements MigrationInterface {
    name = 'BrowserLiveViewAndDropBrowserbase1781200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "browser_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "conversationId" varchar, "runId" varchar, "mcpToken" varchar NOT NULL, "mcpTokenExpiresAt" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "closeReason" varchar, "pageUrl" text NOT NULL DEFAULT (''), "pageTitle" varchar, "viewportWidth" integer NOT NULL DEFAULT (1280), "viewportHeight" integer NOT NULL DEFAULT (800), "startedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_58f28cd53f8d042870e7a92c2c" ON "browser_sessions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_339b67839b06c54aebc971b4e0" ON "browser_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f2279a001f6b0b5c31f893edf0" ON "browser_sessions" ("mcpToken") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc1a88b2687b805dc333f0835c" ON "browser_sessions" ("employeeId", "status") `);
        await queryRunner.query(`CREATE TABLE "temporary_companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "temporary_companies"("id", "name", "slug", "ownerId", "createdAt") SELECT "id", "name", "slug", "ownerId", "createdAt" FROM "companies"`);
        await queryRunner.query(`DROP TABLE "companies"`);
        await queryRunner.query(`ALTER TABLE "temporary_companies" RENAME TO "companies"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" RENAME TO "temporary_companies"`);
        await queryRunner.query(`CREATE TABLE "companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "browserBackend" varchar NOT NULL DEFAULT ('local'), "browserbaseApiKeyEnc" text, "browserbaseProjectId" varchar, CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "companies"("id", "name", "slug", "ownerId", "createdAt") SELECT "id", "name", "slug", "ownerId", "createdAt" FROM "temporary_companies"`);
        await queryRunner.query(`DROP TABLE "temporary_companies"`);
        await queryRunner.query(`DROP INDEX "IDX_fc1a88b2687b805dc333f0835c"`);
        await queryRunner.query(`DROP INDEX "IDX_f2279a001f6b0b5c31f893edf0"`);
        await queryRunner.query(`DROP INDEX "IDX_339b67839b06c54aebc971b4e0"`);
        await queryRunner.query(`DROP INDEX "IDX_58f28cd53f8d042870e7a92c2c"`);
        await queryRunner.query(`DROP TABLE "browser_sessions"`);
    }

}
