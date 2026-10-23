import { MigrationInterface, QueryRunner } from "typeorm";

export class BackupCopies1792746171192 implements MigrationInterface {
    name = 'BackupCopies1792746171192'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "backup_copies" ("id" varchar PRIMARY KEY NOT NULL, "backupId" varchar NOT NULL, "destinationId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "error" text NOT NULL DEFAULT (''), "startedAt" datetime, "copiedAt" datetime, "checkedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_6a54a7d288aef93a0b7f522128" ON "backup_copies" ("destinationId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a02e83c263fad1b62b1f70db34" ON "backup_copies" ("backupId", "destinationId") `);
        await queryRunner.query(`DROP INDEX "IDX_7a4897ff9d33ecf963e08e1138"`);
        await queryRunner.query(`CREATE TABLE "temporary_backups" ("id" varchar PRIMARY KEY NOT NULL, "filename" varchar NOT NULL, "sizeBytes" integer NOT NULL DEFAULT (0), "kind" varchar NOT NULL DEFAULT ('manual'), "status" varchar NOT NULL DEFAULT ('running'), "errorMessage" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "completedAt" datetime, "copiesTracked" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_backups"("id", "filename", "sizeBytes", "kind", "status", "errorMessage", "createdAt", "completedAt") SELECT "id", "filename", "sizeBytes", "kind", "status", "errorMessage", "createdAt", "completedAt" FROM "backups"`);
        await queryRunner.query(`DROP TABLE "backups"`);
        await queryRunner.query(`ALTER TABLE "temporary_backups" RENAME TO "backups"`);
        await queryRunner.query(`CREATE INDEX "IDX_7a4897ff9d33ecf963e08e1138" ON "backups" ("createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7a4897ff9d33ecf963e08e1138"`);
        await queryRunner.query(`ALTER TABLE "backups" RENAME TO "temporary_backups"`);
        await queryRunner.query(`CREATE TABLE "backups" ("id" varchar PRIMARY KEY NOT NULL, "filename" varchar NOT NULL, "sizeBytes" integer NOT NULL DEFAULT (0), "kind" varchar NOT NULL DEFAULT ('manual'), "status" varchar NOT NULL DEFAULT ('running'), "errorMessage" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "completedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "backups"("id", "filename", "sizeBytes", "kind", "status", "errorMessage", "createdAt", "completedAt") SELECT "id", "filename", "sizeBytes", "kind", "status", "errorMessage", "createdAt", "completedAt" FROM "temporary_backups"`);
        await queryRunner.query(`DROP TABLE "temporary_backups"`);
        await queryRunner.query(`CREATE INDEX "IDX_7a4897ff9d33ecf963e08e1138" ON "backups" ("createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_a02e83c263fad1b62b1f70db34"`);
        await queryRunner.query(`DROP INDEX "IDX_6a54a7d288aef93a0b7f522128"`);
        await queryRunner.query(`DROP TABLE "backup_copies"`);
    }

}
