import { MigrationInterface, QueryRunner } from "typeorm";

export class TwoFactorAuthentication1784530570418 implements MigrationInterface {
    name = 'TwoFactorAuthentication1784530570418'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "webauthn_credentials" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "credentialId" varchar(1024) NOT NULL, "publicKey" text NOT NULL, "counter" integer NOT NULL DEFAULT (0), "transports" text, "kind" varchar NOT NULL, "name" varchar(100) NOT NULL, "deviceType" varchar NOT NULL, "backedUp" boolean NOT NULL DEFAULT (0), "lastUsedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_be2025ac9c82bdadcf340b3dfc" ON "webauthn_credentials" ("credentialId") `);
        await queryRunner.query(`CREATE INDEX "IDX_4e5d1a5131f49fdbc410b8ded0" ON "webauthn_credentials" ("userId") `);
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`CREATE TABLE "temporary_users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "totpSecret" text, "totpEnabledAt" datetime, "recoveryCodes" text, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "temporary_users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject" FROM "users"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`ALTER TABLE "temporary_users" RENAME TO "users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME TO "temporary_users"`);
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject" FROM "temporary_users"`);
        await queryRunner.query(`DROP TABLE "temporary_users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
        await queryRunner.query(`DROP INDEX "IDX_4e5d1a5131f49fdbc410b8ded0"`);
        await queryRunner.query(`DROP INDEX "IDX_be2025ac9c82bdadcf340b3dfc"`);
        await queryRunner.query(`DROP TABLE "webauthn_credentials"`);
    }

}
