import { MigrationInterface, QueryRunner } from "typeorm";

export class SaaSDistributedAuth1784617659745 implements MigrationInterface {
    name = "SaaSDistributedAuth1784617659745";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "auth_flow_states" ("id" varchar PRIMARY KEY NOT NULL, "tokenHash" varchar NOT NULL, "kind" varchar NOT NULL, "payloadEncrypted" text NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_75143708da82049f088670ccd5" ON "auth_flow_states" ("expiresAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_68a4ba3026de3d0796752cd0aa" ON "auth_flow_states" ("tokenHash") `);
        await queryRunner.query(`CREATE TABLE "realtime_events" ("id" varchar PRIMARY KEY NOT NULL, "originId" varchar NOT NULL, "companyId" varchar NOT NULL, "eventJson" text NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_22d5ad0cf7c809efd5e26517f1" ON "realtime_events" ("expiresAt") `);
        await queryRunner.query(`DROP INDEX "IDX_1696ad337de0bca45e52a78b22"`);
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`CREATE TABLE "temporary_users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "totpSecret" text, "totpEnabledAt" datetime, "recoveryCodes" text, "sessionVersion" integer NOT NULL DEFAULT (0), "emailVerifiedAt" datetime, "emailVerificationTokenHash" varchar, "emailVerificationExpiresAt" datetime, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "temporary_users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes", "sessionVersion") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes", "sessionVersion" FROM "users"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`ALTER TABLE "temporary_users" RENAME TO "users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1696ad337de0bca45e52a78b22" ON "users" ("handle") WHERE "handle" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
        await queryRunner.query(`CREATE TABLE "temporary_companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "requireTwoFactor" boolean NOT NULL DEFAULT (0), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "temporary_companies"("id", "name", "slug", "ownerId", "createdAt") SELECT "id", "name", "slug", "ownerId", "createdAt" FROM "companies"`);
        await queryRunner.query(`DROP TABLE "companies"`);
        await queryRunner.query(`ALTER TABLE "temporary_companies" RENAME TO "companies"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" RENAME TO "temporary_companies"`);
        await queryRunner.query(`CREATE TABLE "companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "companies"("id", "name", "slug", "ownerId", "createdAt") SELECT "id", "name", "slug", "ownerId", "createdAt" FROM "temporary_companies"`);
        await queryRunner.query(`DROP TABLE "temporary_companies"`);
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`DROP INDEX "IDX_1696ad337de0bca45e52a78b22"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME TO "temporary_users"`);
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "totpSecret" text, "totpEnabledAt" datetime, "recoveryCodes" text, "sessionVersion" integer NOT NULL DEFAULT (0), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes", "sessionVersion") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes", "sessionVersion" FROM "temporary_users"`);
        await queryRunner.query(`DROP TABLE "temporary_users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1696ad337de0bca45e52a78b22" ON "users" ("handle") WHERE "handle" IS NOT NULL`);
        await queryRunner.query(`DROP INDEX "IDX_22d5ad0cf7c809efd5e26517f1"`);
        await queryRunner.query(`DROP TABLE "realtime_events"`);
        await queryRunner.query(`DROP INDEX "IDX_68a4ba3026de3d0796752cd0aa"`);
        await queryRunner.query(`DROP INDEX "IDX_75143708da82049f088670ccd5"`);
        await queryRunner.query(`DROP TABLE "auth_flow_states"`);
    }
}
