import { MigrationInterface, QueryRunner } from "typeorm";

export class BackupDestinations1783623733179 implements MigrationInterface {
    name = 'BackupDestinations1783623733179'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "backup_destinations" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('local'), "enabled" boolean NOT NULL DEFAULT (1), "encryptedConfig" text NOT NULL, "hint" varchar NOT NULL DEFAULT (''), "lastStatus" varchar NOT NULL DEFAULT ('unknown'), "lastError" text NOT NULL DEFAULT (''), "lastSyncedAt" datetime, "lastCheckedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_cb8144bbf780a2747bc5cdd9e2" ON "backup_destinations" ("createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cb8144bbf780a2747bc5cdd9e2"`);
        await queryRunner.query(`DROP TABLE "backup_destinations"`);
    }

}
