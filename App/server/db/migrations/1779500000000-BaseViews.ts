import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Saved views on BaseTables: filters, sort, and hidden fields packed into
 * JSON columns. Each table auto-creates a default "Grid view" the first
 * time it is opened so the UI never has to special-case "no views yet".
 */
export class BaseViews1779500000000 implements MigrationInterface {
  name = "BaseViews1779500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "base_views" (
        "id" varchar PRIMARY KEY NOT NULL,
        "tableId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "sortOrder" float NOT NULL DEFAULT (0),
        "filtersJson" text NOT NULL DEFAULT ('[]'),
        "sortsJson" text NOT NULL DEFAULT ('[]'),
        "hiddenFieldsJson" text NOT NULL DEFAULT ('[]'),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_base_views_tableId_slug" ON "base_views" ("tableId", "slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_base_views_tableId_sortOrder" ON "base_views" ("tableId", "sortOrder")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_base_views_tableId_sortOrder"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_base_views_tableId_slug"`,
    );
    await queryRunner.query(`DROP TABLE "base_views"`);
  }
}
