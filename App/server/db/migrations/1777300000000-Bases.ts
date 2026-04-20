import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Airtable-style Bases: a Company owns N Bases, each Base owns N BaseTables,
 * each BaseTable owns N BaseFields and N BaseRecords. Records are stored as
 * a JSON blob keyed by field id so schema edits never migrate data.
 */
export class Bases1777300000000 implements MigrationInterface {
  name = "Bases1777300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "bases" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "description" text NOT NULL DEFAULT (''),
        "icon" varchar NOT NULL DEFAULT ('Database'),
        "color" varchar NOT NULL DEFAULT ('indigo'),
        "createdById" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_bases_companyId_slug" ON "bases" ("companyId", "slug")`,
    );

    await queryRunner.query(
      `CREATE TABLE "base_tables" (
        "id" varchar PRIMARY KEY NOT NULL,
        "baseId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "sortOrder" float NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_base_tables_baseId_slug" ON "base_tables" ("baseId", "slug")`,
    );

    await queryRunner.query(
      `CREATE TABLE "base_fields" (
        "id" varchar PRIMARY KEY NOT NULL,
        "tableId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "type" varchar NOT NULL,
        "configJson" text NOT NULL DEFAULT ('{}'),
        "isPrimary" boolean NOT NULL DEFAULT (0),
        "sortOrder" float NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_base_fields_tableId_sortOrder" ON "base_fields" ("tableId", "sortOrder")`,
    );

    await queryRunner.query(
      `CREATE TABLE "base_records" (
        "id" varchar PRIMARY KEY NOT NULL,
        "tableId" varchar NOT NULL,
        "dataJson" text NOT NULL DEFAULT ('{}'),
        "sortOrder" float NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_base_records_tableId_createdAt" ON "base_records" ("tableId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_base_records_tableId_createdAt"`);
    await queryRunner.query(`DROP TABLE "base_records"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_base_fields_tableId_sortOrder"`);
    await queryRunner.query(`DROP TABLE "base_fields"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_base_tables_baseId_slug"`);
    await queryRunner.query(`DROP TABLE "base_tables"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_bases_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "bases"`);
  }
}
