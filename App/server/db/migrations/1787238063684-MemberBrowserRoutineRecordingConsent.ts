import { MigrationInterface, QueryRunner } from "typeorm";

export class MemberBrowserRoutineRecordingConsent1787238063684 implements MigrationInterface {
    name = 'MemberBrowserRoutineRecordingConsent1787238063684'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_675c36aaea578f71099549a57e"`);
        await queryRunner.query(`DROP INDEX "IDX_0747743c60b5b20a1132f4d4c9"`);
        await queryRunner.query(`DROP INDEX "IDX_866b9d867253051a653a5d4783"`);
        await queryRunner.query(`DROP INDEX "IDX_38a9d8659c2dc2c30196875b5a"`);
        await queryRunner.query(`CREATE TABLE "temporary_member_browsers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "ownerUserId" varchar NOT NULL, "name" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "pairingCodeHash" varchar(64), "pairingCodeExpiresAt" datetime, "tokenHash" varchar(64), "tokenPrefix" varchar(16), "allowedHosts" text, "approvalRequired" boolean NOT NULL DEFAULT (1), "allowUnattended" boolean NOT NULL DEFAULT (0), "browserVersion" varchar, "platform" varchar, "lastSeenAt" datetime, "revokedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "routineRecordingConsentAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_member_browsers"("id", "companyId", "ownerUserId", "name", "status", "pairingCodeHash", "pairingCodeExpiresAt", "tokenHash", "tokenPrefix", "allowedHosts", "approvalRequired", "allowUnattended", "browserVersion", "platform", "lastSeenAt", "revokedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "ownerUserId", "name", "status", "pairingCodeHash", "pairingCodeExpiresAt", "tokenHash", "tokenPrefix", "allowedHosts", "approvalRequired", "allowUnattended", "browserVersion", "platform", "lastSeenAt", "revokedAt", "createdAt", "updatedAt" FROM "member_browsers"`);
        await queryRunner.query(`DROP TABLE "member_browsers"`);
        await queryRunner.query(`ALTER TABLE "temporary_member_browsers" RENAME TO "member_browsers"`);
        await queryRunner.query(`CREATE INDEX "IDX_675c36aaea578f71099549a57e" ON "member_browsers" ("companyId", "ownerUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0747743c60b5b20a1132f4d4c9" ON "member_browsers" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_866b9d867253051a653a5d4783" ON "member_browsers" ("ownerUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_38a9d8659c2dc2c30196875b5a" ON "member_browsers" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_38a9d8659c2dc2c30196875b5a"`);
        await queryRunner.query(`DROP INDEX "IDX_866b9d867253051a653a5d4783"`);
        await queryRunner.query(`DROP INDEX "IDX_0747743c60b5b20a1132f4d4c9"`);
        await queryRunner.query(`DROP INDEX "IDX_675c36aaea578f71099549a57e"`);
        await queryRunner.query(`ALTER TABLE "member_browsers" RENAME TO "temporary_member_browsers"`);
        await queryRunner.query(`CREATE TABLE "member_browsers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "ownerUserId" varchar NOT NULL, "name" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "pairingCodeHash" varchar(64), "pairingCodeExpiresAt" datetime, "tokenHash" varchar(64), "tokenPrefix" varchar(16), "allowedHosts" text, "approvalRequired" boolean NOT NULL DEFAULT (1), "allowUnattended" boolean NOT NULL DEFAULT (0), "browserVersion" varchar, "platform" varchar, "lastSeenAt" datetime, "revokedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "member_browsers"("id", "companyId", "ownerUserId", "name", "status", "pairingCodeHash", "pairingCodeExpiresAt", "tokenHash", "tokenPrefix", "allowedHosts", "approvalRequired", "allowUnattended", "browserVersion", "platform", "lastSeenAt", "revokedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "ownerUserId", "name", "status", "pairingCodeHash", "pairingCodeExpiresAt", "tokenHash", "tokenPrefix", "allowedHosts", "approvalRequired", "allowUnattended", "browserVersion", "platform", "lastSeenAt", "revokedAt", "createdAt", "updatedAt" FROM "temporary_member_browsers"`);
        await queryRunner.query(`DROP TABLE "temporary_member_browsers"`);
        await queryRunner.query(`CREATE INDEX "IDX_38a9d8659c2dc2c30196875b5a" ON "member_browsers" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_866b9d867253051a653a5d4783" ON "member_browsers" ("ownerUserId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_0747743c60b5b20a1132f4d4c9" ON "member_browsers" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_675c36aaea578f71099549a57e" ON "member_browsers" ("companyId", "ownerUserId") `);
    }

}
