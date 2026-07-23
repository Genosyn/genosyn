import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `SkillToolset1784825744991` migration.
 * The Postgres stream is a squashed initial snapshot plus tail deltas (see
 * server/db/migrations/postgres/) — a column added after PostgresInitial lands
 * as its own delta here rather than editing the snapshot.
 *
 * The sqlite migration rebuilds the table because SQLite cannot add a column
 * with a changed layout in place; Postgres can, so this is the plain
 * `ALTER TABLE`. The resulting column is identical: nullable `text`, no
 * default, so a future `migration:generate` on Postgres sees no drift.
 */
export class SkillToolset1784825744992 implements MigrationInterface {
  name = "SkillToolset1784825744992";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" ADD "toolsetJson" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN "toolsetJson"`);
  }
}
