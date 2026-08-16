import { MigrationInterface, QueryRunner } from "typeorm";

export class MemberBrowsers1786874102752 implements MigrationInterface {
    name = 'MemberBrowsers1786874102752'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "member_browsers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "ownerUserId" varchar NOT NULL, "name" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "pairingCodeHash" varchar(64), "pairingCodeExpiresAt" datetime, "tokenHash" varchar(64), "tokenPrefix" varchar(16), "allowedHosts" text, "approvalRequired" boolean NOT NULL DEFAULT (1), "allowUnattended" boolean NOT NULL DEFAULT (0), "browserVersion" varchar, "platform" varchar, "lastSeenAt" datetime, "revokedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_38a9d8659c2dc2c30196875b5a" ON "member_browsers" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_866b9d867253051a653a5d4783" ON "member_browsers" ("ownerUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0747743c60b5b20a1132f4d4c9" ON "member_browsers" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_675c36aaea578f71099549a57e" ON "member_browsers" ("companyId", "ownerUserId") `);
        await queryRunner.query(`CREATE TABLE "employee_member_browser_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "memberBrowserId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9620dde0901380e6c914864281" ON "employee_member_browser_grants" ("employeeId", "memberBrowserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5e3aac3d293b4dd58f811d2f85" ON "employee_member_browser_grants" ("memberBrowserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b30f7588502ac0c65852e120e0" ON "employee_member_browser_grants" ("employeeId") `);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`CREATE TABLE "temporary_routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0), "memberBrowserId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout" FROM "routines"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`ALTER TABLE "temporary_routines" RENAME TO "routines"`);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`CREATE TABLE "temporary_conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar, "memberBrowserId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId" FROM "conversations"`);
        await queryRunner.query(`DROP TABLE "conversations"`);
        await queryRunner.query(`ALTER TABLE "temporary_conversations" RENAME TO "conversations"`);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
        await queryRunner.query(`DROP INDEX "IDX_fc1a88b2687b805dc333f0835c"`);
        await queryRunner.query(`DROP INDEX "IDX_f2279a001f6b0b5c31f893edf0"`);
        await queryRunner.query(`DROP INDEX "IDX_339b67839b06c54aebc971b4e0"`);
        await queryRunner.query(`DROP INDEX "IDX_58f28cd53f8d042870e7a92c2c"`);
        await queryRunner.query(`CREATE TABLE "temporary_browser_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "conversationId" varchar, "runId" varchar, "mcpToken" varchar NOT NULL, "mcpTokenExpiresAt" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "closeReason" varchar, "pageUrl" text NOT NULL DEFAULT (''), "pageTitle" varchar, "viewportWidth" integer NOT NULL DEFAULT (1280), "viewportHeight" integer NOT NULL DEFAULT (800), "startedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "memberBrowserId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_browser_sessions"("id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt") SELECT "id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt" FROM "browser_sessions"`);
        await queryRunner.query(`DROP TABLE "browser_sessions"`);
        await queryRunner.query(`ALTER TABLE "temporary_browser_sessions" RENAME TO "browser_sessions"`);
        await queryRunner.query(`CREATE INDEX "IDX_fc1a88b2687b805dc333f0835c" ON "browser_sessions" ("employeeId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f2279a001f6b0b5c31f893edf0" ON "browser_sessions" ("mcpToken") `);
        await queryRunner.query(`CREATE INDEX "IDX_339b67839b06c54aebc971b4e0" ON "browser_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_58f28cd53f8d042870e7a92c2c" ON "browser_sessions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e29c351af77efbe3e30d0b5ab" ON "browser_sessions" ("memberBrowserId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_8e29c351af77efbe3e30d0b5ab"`);
        await queryRunner.query(`DROP INDEX "IDX_58f28cd53f8d042870e7a92c2c"`);
        await queryRunner.query(`DROP INDEX "IDX_339b67839b06c54aebc971b4e0"`);
        await queryRunner.query(`DROP INDEX "IDX_f2279a001f6b0b5c31f893edf0"`);
        await queryRunner.query(`DROP INDEX "IDX_fc1a88b2687b805dc333f0835c"`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" RENAME TO "temporary_browser_sessions"`);
        await queryRunner.query(`CREATE TABLE "browser_sessions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "conversationId" varchar, "runId" varchar, "mcpToken" varchar NOT NULL, "mcpTokenExpiresAt" datetime NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "closeReason" varchar, "pageUrl" text NOT NULL DEFAULT (''), "pageTitle" varchar, "viewportWidth" integer NOT NULL DEFAULT (1280), "viewportHeight" integer NOT NULL DEFAULT (800), "startedAt" datetime, "closedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "browser_sessions"("id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt") SELECT "id", "companyId", "employeeId", "conversationId", "runId", "mcpToken", "mcpTokenExpiresAt", "status", "closeReason", "pageUrl", "pageTitle", "viewportWidth", "viewportHeight", "startedAt", "closedAt", "createdAt" FROM "temporary_browser_sessions"`);
        await queryRunner.query(`DROP TABLE "temporary_browser_sessions"`);
        await queryRunner.query(`CREATE INDEX "IDX_58f28cd53f8d042870e7a92c2c" ON "browser_sessions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_339b67839b06c54aebc971b4e0" ON "browser_sessions" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f2279a001f6b0b5c31f893edf0" ON "browser_sessions" ("mcpToken") `);
        await queryRunner.query(`CREATE INDEX "IDX_fc1a88b2687b805dc333f0835c" ON "browser_sessions" ("employeeId", "status") `);
        await queryRunner.query(`DROP INDEX "IDX_7df471803dc181471c8c108a0e"`);
        await queryRunner.query(`DROP INDEX "IDX_6ff3d71f2dd0e7728bdd151bff"`);
        await queryRunner.query(`DROP INDEX "IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`ALTER TABLE "conversations" RENAME TO "temporary_conversations"`);
        await queryRunner.query(`CREATE TABLE "conversations" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "title" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime, "source" varchar NOT NULL DEFAULT ('web'), "externalKey" varchar, "connectionId" varchar, "ownerUserId" varchar)`);
        await queryRunner.query(`INSERT INTO "conversations"("id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId") SELECT "id", "employeeId", "title", "createdAt", "updatedAt", "archivedAt", "source", "externalKey", "connectionId", "ownerUserId" FROM "temporary_conversations"`);
        await queryRunner.query(`DROP TABLE "temporary_conversations"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7df471803dc181471c8c108a0e" ON "conversations" ("source", "connectionId", "externalKey") WHERE "externalKey" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_6ff3d71f2dd0e7728bdd151bff" ON "conversations" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP INDEX "IDX_ef3c194cfdbf720e71464a3b30"`);
        await queryRunner.query(`ALTER TABLE "routines" RENAME TO "temporary_routines"`);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "timeoutSec" integer NOT NULL DEFAULT (3600), "requiresApproval" boolean NOT NULL DEFAULT (0), "webhookEnabled" boolean NOT NULL DEFAULT (0), "webhookToken" varchar, "body" text NOT NULL DEFAULT (''), "nextRunAt" datetime, "browserEnabledOverride" boolean, "modelId" varchar, "catchUpPolicy" varchar NOT NULL DEFAULT ('once'), "maxAttempts" integer NOT NULL DEFAULT (1), "retryBackoffSec" integer NOT NULL DEFAULT (60), "retryOnTimeout" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "routines"("id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout") SELECT "id", "employeeId", "name", "slug", "cronExpr", "enabled", "lastRunAt", "createdAt", "timeoutSec", "requiresApproval", "webhookEnabled", "webhookToken", "body", "nextRunAt", "browserEnabledOverride", "modelId", "catchUpPolicy", "maxAttempts", "retryBackoffSec", "retryOnTimeout" FROM "temporary_routines"`);
        await queryRunner.query(`DROP TABLE "temporary_routines"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `);
        await queryRunner.query(`DROP INDEX "IDX_b30f7588502ac0c65852e120e0"`);
        await queryRunner.query(`DROP INDEX "IDX_5e3aac3d293b4dd58f811d2f85"`);
        await queryRunner.query(`DROP INDEX "IDX_9620dde0901380e6c914864281"`);
        await queryRunner.query(`DROP TABLE "employee_member_browser_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_675c36aaea578f71099549a57e"`);
        await queryRunner.query(`DROP INDEX "IDX_0747743c60b5b20a1132f4d4c9"`);
        await queryRunner.query(`DROP INDEX "IDX_866b9d867253051a653a5d4783"`);
        await queryRunner.query(`DROP INDEX "IDX_38a9d8659c2dc2c30196875b5a"`);
        await queryRunner.query(`DROP TABLE "member_browsers"`);
    }

}
