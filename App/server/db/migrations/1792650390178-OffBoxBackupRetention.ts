import { MigrationInterface, QueryRunner } from "typeorm";

export class OffBoxBackupRetention1792650390178 implements MigrationInterface {
    name = 'OffBoxBackupRetention1792650390178'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "temporary_backup_schedules" ("id" varchar PRIMARY KEY NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "frequency" varchar NOT NULL DEFAULT ('daily'), "hour" integer NOT NULL DEFAULT (3), "dayOfWeek" integer NOT NULL DEFAULT (0), "dayOfMonth" integer NOT NULL DEFAULT (1), "lastRunAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "retentionEnabled" boolean NOT NULL DEFAULT (0), "retentionDays" integer NOT NULL DEFAULT (30), "offBoxRetentionEnabled" boolean NOT NULL DEFAULT (0), "offBoxRetentionDays" integer NOT NULL DEFAULT (30))`);
        await queryRunner.query(`INSERT INTO "temporary_backup_schedules"("id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt", "retentionEnabled", "retentionDays") SELECT "id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt", "retentionEnabled", "retentionDays" FROM "backup_schedules"`);
        await queryRunner.query(`DROP TABLE "backup_schedules"`);
        await queryRunner.query(`ALTER TABLE "temporary_backup_schedules" RENAME TO "backup_schedules"`);
        await queryRunner.query(`DROP INDEX "IDX_cb8144bbf780a2747bc5cdd9e2"`);
        await queryRunner.query(`CREATE TABLE "temporary_backup_destinations" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('local'), "enabled" boolean NOT NULL DEFAULT (1), "encryptedConfig" text NOT NULL, "hint" varchar NOT NULL DEFAULT (''), "lastStatus" varchar NOT NULL DEFAULT ('unknown'), "lastError" text NOT NULL DEFAULT (''), "lastSyncedAt" datetime, "lastCheckedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "lastAttemptAt" datetime, "failingSince" datetime, "lastAlertedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_backup_destinations"("id", "name", "kind", "enabled", "encryptedConfig", "hint", "lastStatus", "lastError", "lastSyncedAt", "lastCheckedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "name", "kind", "enabled", "encryptedConfig", "hint", "lastStatus", "lastError", "lastSyncedAt", "lastCheckedAt", "createdById", "createdAt", "updatedAt" FROM "backup_destinations"`);
        await queryRunner.query(`DROP TABLE "backup_destinations"`);
        await queryRunner.query(`ALTER TABLE "temporary_backup_destinations" RENAME TO "backup_destinations"`);
        await queryRunner.query(`CREATE INDEX "IDX_cb8144bbf780a2747bc5cdd9e2" ON "backup_destinations" ("createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_cb8144bbf780a2747bc5cdd9e2"`);
        await queryRunner.query(`ALTER TABLE "backup_destinations" RENAME TO "temporary_backup_destinations"`);
        await queryRunner.query(`CREATE TABLE "backup_destinations" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('local'), "enabled" boolean NOT NULL DEFAULT (1), "encryptedConfig" text NOT NULL, "hint" varchar NOT NULL DEFAULT (''), "lastStatus" varchar NOT NULL DEFAULT ('unknown'), "lastError" text NOT NULL DEFAULT (''), "lastSyncedAt" datetime, "lastCheckedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "backup_destinations"("id", "name", "kind", "enabled", "encryptedConfig", "hint", "lastStatus", "lastError", "lastSyncedAt", "lastCheckedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "name", "kind", "enabled", "encryptedConfig", "hint", "lastStatus", "lastError", "lastSyncedAt", "lastCheckedAt", "createdById", "createdAt", "updatedAt" FROM "temporary_backup_destinations"`);
        await queryRunner.query(`DROP TABLE "temporary_backup_destinations"`);
        await queryRunner.query(`CREATE INDEX "IDX_cb8144bbf780a2747bc5cdd9e2" ON "backup_destinations" ("createdAt") `);
        await queryRunner.query(`ALTER TABLE "backup_schedules" RENAME TO "temporary_backup_schedules"`);
        await queryRunner.query(`CREATE TABLE "backup_schedules" ("id" varchar PRIMARY KEY NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "frequency" varchar NOT NULL DEFAULT ('daily'), "hour" integer NOT NULL DEFAULT (3), "dayOfWeek" integer NOT NULL DEFAULT (0), "dayOfMonth" integer NOT NULL DEFAULT (1), "lastRunAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "retentionEnabled" boolean NOT NULL DEFAULT (0), "retentionDays" integer NOT NULL DEFAULT (30))`);
        await queryRunner.query(`INSERT INTO "backup_schedules"("id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt", "retentionEnabled", "retentionDays") SELECT "id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt", "retentionEnabled", "retentionDays" FROM "temporary_backup_schedules"`);
        await queryRunner.query(`DROP TABLE "temporary_backup_schedules"`);
    }

}
