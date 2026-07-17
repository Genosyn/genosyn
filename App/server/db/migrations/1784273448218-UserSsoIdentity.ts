import { MigrationInterface, QueryRunner } from "typeorm";

export class UserSsoIdentity1784273448218 implements MigrationInterface {
    name = 'UserSsoIdentity1784273448218'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`CREATE TABLE "temporary_users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), "ssoIssuer" varchar, "ssoSubject" varchar, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "temporary_users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin" FROM "users"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`ALTER TABLE "temporary_users" RENAME TO "users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_05a1670f661022d9a22630eb93" ON "users" ("ssoIssuer", "ssoSubject") WHERE "ssoSubject" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_05a1670f661022d9a22630eb93"`);
        await queryRunner.query(`DROP INDEX "IDX_91d1c91102a6576f36e643ac5f"`);
        await queryRunner.query(`ALTER TABLE "users" RENAME TO "temporary_users"`);
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "handle" varchar, "avatarKey" varchar, "isMasterAdmin" boolean NOT NULL DEFAULT (0), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`INSERT INTO "users"("id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin") SELECT "id", "email", "passwordHash", "name", "resetToken", "resetExpiresAt", "createdAt", "handle", "avatarKey", "isMasterAdmin" FROM "temporary_users"`);
        await queryRunner.query(`DROP TABLE "temporary_users"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_91d1c91102a6576f36e643ac5f" ON "users" ("handle") WHERE handle IS NOT NULL`);
    }

}
