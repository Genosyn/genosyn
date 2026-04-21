import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backups table: one row per archive written under `<dataDir>/Backup/`.
 * BackupSchedule: singleton ('default') holding the recurring-backup config.
 */
export class Backups1777600000000 implements MigrationInterface {
  name = "Backups1777600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "backups" (
        "id" varchar PRIMARY KEY NOT NULL,
        "filename" varchar NOT NULL,
        "sizeBytes" integer NOT NULL DEFAULT (0),
        "kind" varchar NOT NULL DEFAULT ('manual'),
        "status" varchar NOT NULL DEFAULT ('running'),
        "errorMessage" text NOT NULL DEFAULT (''),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "completedAt" datetime
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_backups_createdAt" ON "backups" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE TABLE "backup_schedules" (
        "id" varchar PRIMARY KEY NOT NULL,
        "enabled" boolean NOT NULL DEFAULT (0),
        "frequency" varchar NOT NULL DEFAULT ('daily'),
        "hour" integer NOT NULL DEFAULT (3),
        "dayOfWeek" integer NOT NULL DEFAULT (0),
        "dayOfMonth" integer NOT NULL DEFAULT (1),
        "lastRunAt" datetime,
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "backup_schedules"`);
    await queryRunner.query(`DROP INDEX "IDX_backups_createdAt"`);
    await queryRunner.query(`DROP TABLE "backups"`);
  }
}
