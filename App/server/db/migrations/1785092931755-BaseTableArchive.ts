import { MigrationInterface, QueryRunner } from "typeorm";

export class BaseTableArchive1785092931755 implements MigrationInterface {
    name = 'BaseTableArchive1785092931755'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_1e6e53308ca740c41a1afe390d"`);
        await queryRunner.query(`CREATE TABLE "temporary_base_tables" ("id" varchar PRIMARY KEY NOT NULL, "baseId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "sortOrder" float NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "archivedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_base_tables"("id", "baseId", "name", "slug", "sortOrder", "createdAt") SELECT "id", "baseId", "name", "slug", "sortOrder", "createdAt" FROM "base_tables"`);
        await queryRunner.query(`DROP TABLE "base_tables"`);
        await queryRunner.query(`ALTER TABLE "temporary_base_tables" RENAME TO "base_tables"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1e6e53308ca740c41a1afe390d" ON "base_tables" ("baseId", "slug") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_1e6e53308ca740c41a1afe390d"`);
        await queryRunner.query(`ALTER TABLE "base_tables" RENAME TO "temporary_base_tables"`);
        await queryRunner.query(`CREATE TABLE "base_tables" ("id" varchar PRIMARY KEY NOT NULL, "baseId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "sortOrder" float NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "base_tables"("id", "baseId", "name", "slug", "sortOrder", "createdAt") SELECT "id", "baseId", "name", "slug", "sortOrder", "createdAt" FROM "temporary_base_tables"`);
        await queryRunner.query(`DROP TABLE "temporary_base_tables"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1e6e53308ca740c41a1afe390d" ON "base_tables" ("baseId", "slug") `);
    }

}
