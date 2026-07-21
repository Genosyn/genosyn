import { MigrationInterface, QueryRunner } from "typeorm";

export class SaaSHardening1784536421883 implements MigrationInterface {
    name = "SaaSHardening1784536421883";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "auth_rate_limits" ("id" varchar PRIMARY KEY NOT NULL, "attempts" integer NOT NULL DEFAULT (0), "windowStartedAt" datetime NOT NULL, "blockedUntil" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE TABLE "workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
        await queryRunner.query(`CREATE TABLE "scheduler_leases" ("name" varchar PRIMARY KEY NOT NULL, "holderId" varchar NOT NULL DEFAULT (''), "expiresAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`CREATE TABLE "temporary_users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "totpSecret" text, "totpEnabledAt" datetime, "recoveryCodes" text, "sessionVersion" integer NOT NULL DEFAULT (0), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "temporary_users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes" FROM "users"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`ALTER TABLE "temporary_users" RENAME TO "users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME TO "temporary_users"`);
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "totpSecret" text, "totpEnabledAt" datetime, "recoveryCodes" text, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "totpSecret", "totpEnabledAt", "recoveryCodes" FROM "temporary_users"`);
        await queryRunner.query(`DROP TABLE "temporary_users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
        await queryRunner.query(`DROP TABLE "scheduler_leases"`);
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`DROP TABLE "workload_leases"`);
        await queryRunner.query(`DROP TABLE "auth_rate_limits"`);
    }
}
