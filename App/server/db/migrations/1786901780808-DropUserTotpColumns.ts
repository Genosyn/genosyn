import { MigrationInterface, QueryRunner } from "typeorm";

export class DropUserTotpColumns1786901780808 implements MigrationInterface {
    name = 'DropUserTotpColumns1786901780808'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`DROP INDEX "IDX_1696ad337de0bca45e52a78b22"`);
        await queryRunner.query(`CREATE TABLE "temporary_users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "recoveryCodes" text, "sessionVersion" integer NOT NULL DEFAULT (0), "emailVerifiedAt" datetime, "emailVerificationTokenHash" varchar, "emailVerificationExpiresAt" datetime, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "temporary_users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "recoveryCodes", "sessionVersion", "emailVerifiedAt", "emailVerificationTokenHash", "emailVerificationExpiresAt") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "recoveryCodes", "sessionVersion", "emailVerifiedAt", "emailVerificationTokenHash", "emailVerificationExpiresAt" FROM "users"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`ALTER TABLE "temporary_users" RENAME TO "users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1696ad337de0bca45e52a78b22" ON "users" ("handle") WHERE "handle" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_1696ad337de0bca45e52a78b22"`);
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME TO "temporary_users"`);
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, "totpSecret" text, "totpEnabledAt" datetime, "recoveryCodes" text, "sessionVersion" integer NOT NULL DEFAULT (0), "emailVerifiedAt" datetime, "emailVerificationTokenHash" varchar, "emailVerificationExpiresAt" datetime, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "recoveryCodes", "sessionVersion", "emailVerifiedAt", "emailVerificationTokenHash", "emailVerificationExpiresAt") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin", "ssoIssuer", "ssoSubject", "recoveryCodes", "sessionVersion", "emailVerifiedAt", "emailVerificationTokenHash", "emailVerificationExpiresAt" FROM "temporary_users"`);
        await queryRunner.query(`DROP TABLE "temporary_users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1696ad337de0bca45e52a78b22" ON "users" ("handle") WHERE "handle" IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
    }

}
