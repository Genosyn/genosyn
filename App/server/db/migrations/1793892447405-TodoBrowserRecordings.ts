import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoBrowserRecordings1793892447405 implements MigrationInterface {
    name = 'TodoBrowserRecordings1793892447405'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d680372f43ccddadc82d6293d1"`);
        await queryRunner.query(`DROP INDEX "IDX_8e29c351af77efbe3e30d0b5ab"`);
        await queryRunner.query(`DROP INDEX "IDX_58f28cd53f8d042870e7a92c2c"`);
        await queryRunner.query(`DROP INDEX "IDX_339b67839b06c54aebc971b4e0"`);
        await queryRunner.query(`DROP INDEX "IDX_f2279a001f6b0b5c31f893edf0"`);
        await queryRunner.query(`DROP INDEX "IDX_fc1a88b2687b805dc333f0835c"`);
        await queryRunner.query(`CREATE TABLE "temporary_browser_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "conversationId" varchar, "runId" varchar, "mcpToken" varchar NOT NULL, "mcpTokenExpiresAt" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "closeReason" varchar, "pageUrl" text NOT NULL DEFAULT (''), "pageTitle" varchar, "viewportWidth" integer NOT NULL DEFAULT (1280), "viewportHeight" integer NOT NULL DEFAULT (800), "startedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "memberBrowserId" varchar, "todoId" varchar, "todoPickupId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_browser_sessions"("id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt", "memberBrowserId") SELECT "id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt", "memberBrowserId" FROM "browser_sessions"`);
        await queryRunner.query(`DROP TABLE "browser_sessions"`);
        await queryRunner.query(`ALTER TABLE "temporary_browser_sessions" RENAME TO "browser_sessions"`);
        await queryRunner.query(`CREATE INDEX "IDX_d680372f43ccddadc82d6293d1" ON "browser_sessions" ("runId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e29c351af77efbe3e30d0b5ab" ON "browser_sessions" ("memberBrowserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_58f28cd53f8d042870e7a92c2c" ON "browser_sessions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_339b67839b06c54aebc971b4e0" ON "browser_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f2279a001f6b0b5c31f893edf0" ON "browser_sessions" ("mcpToken") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc1a88b2687b805dc333f0835c" ON "browser_sessions" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_dc5d169985eab001cd8890a9fe" ON "browser_sessions" ("todoId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_dc5d169985eab001cd8890a9fe"`);
        await queryRunner.query(`DROP INDEX "IDX_fc1a88b2687b805dc333f0835c"`);
        await queryRunner.query(`DROP INDEX "IDX_f2279a001f6b0b5c31f893edf0"`);
        await queryRunner.query(`DROP INDEX "IDX_339b67839b06c54aebc971b4e0"`);
        await queryRunner.query(`DROP INDEX "IDX_58f28cd53f8d042870e7a92c2c"`);
        await queryRunner.query(`DROP INDEX "IDX_8e29c351af77efbe3e30d0b5ab"`);
        await queryRunner.query(`DROP INDEX "IDX_d680372f43ccddadc82d6293d1"`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" RENAME TO "temporary_browser_sessions"`);
        await queryRunner.query(`CREATE TABLE "browser_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "conversationId" varchar, "runId" varchar, "mcpToken" varchar NOT NULL, "mcpTokenExpiresAt" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "closeReason" varchar, "pageUrl" text NOT NULL DEFAULT (''), "pageTitle" varchar, "viewportWidth" integer NOT NULL DEFAULT (1280), "viewportHeight" integer NOT NULL DEFAULT (800), "startedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "memberBrowserId" varchar)`);
        await queryRunner.query(`INSERT INTO "browser_sessions"("id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt", "memberBrowserId") SELECT "id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt", "memberBrowserId" FROM "temporary_browser_sessions"`);
        await queryRunner.query(`DROP TABLE "temporary_browser_sessions"`);
        await queryRunner.query(`CREATE INDEX "IDX_fc1a88b2687b805dc333f0835c" ON "browser_sessions" ("employeeId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f2279a001f6b0b5c31f893edf0" ON "browser_sessions" ("mcpToken") `);
        await queryRunner.query(`CREATE INDEX "IDX_339b67839b06c54aebc971b4e0" ON "browser_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_58f28cd53f8d042870e7a92c2c" ON "browser_sessions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e29c351af77efbe3e30d0b5ab" ON "browser_sessions" ("memberBrowserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d680372f43ccddadc82d6293d1" ON "browser_sessions" ("runId") `);
    }

}
