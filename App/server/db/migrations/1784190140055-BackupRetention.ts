import { MigrationInterface, QueryRunner } from "typeorm";

export class BackupRetention1784190140055 implements MigrationInterface {
    name = 'BackupRetention1784190140055'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "temporary_backup_schedules" ("id" varchar PRIMARY KEY NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "frequency" varchar NOT NULL DEFAULT ('daily'), "hour" integer NOT NULL DEFAULT (3), "dayOfWeek" integer NOT NULL DEFAULT (0), "dayOfMonth" integer NOT NULL DEFAULT (1), "lastRunAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "retentionEnabled" boolean NOT NULL DEFAULT (0), "retentionDays" integer NOT NULL DEFAULT (30))`);
        await queryRunner.query(`INSERT INTO "temporary_backup_schedules"("id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt") SELECT "id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt" FROM "backup_schedules"`);
        await queryRunner.query(`DROP TABLE "backup_schedules"`);
        await queryRunner.query(`ALTER TABLE "temporary_backup_schedules" RENAME TO "backup_schedules"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "backup_schedules" RENAME TO "temporary_backup_schedules"`);
        await queryRunner.query(`CREATE TABLE "backup_schedules" ("id" varchar PRIMARY KEY NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "frequency" varchar NOT NULL DEFAULT ('daily'), "hour" integer NOT NULL DEFAULT (3), "dayOfWeek" integer NOT NULL DEFAULT (0), "dayOfMonth" integer NOT NULL DEFAULT (1), "lastRunAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "backup_schedules"("id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt") SELECT "id", "enabled", "frequency", "hour", "dayOfWeek", "dayOfMonth", "lastRunAt", "updatedAt" FROM "temporary_backup_schedules"`);
        await queryRunner.query(`DROP TABLE "temporary_backup_schedules"`);
    }

}
