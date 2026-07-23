import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `MailDraftAttribution1784836230875`
 * migration. The Postgres stream is a squashed initial snapshot plus tail
 * deltas (see server/db/migrations/postgres/) — columns added after
 * PostgresInitial land as their own delta here rather than editing the
 * snapshot.
 *
 * The sqlite migration rebuilds `mail_messages` because SQLite cannot add
 * columns with a changed layout in place; Postgres can, so this is four plain
 * `ALTER TABLE`s. The resulting columns are identical: nullable
 * `character varying`, no default, so a future `migration:generate` on
 * Postgres sees no drift.
 *
 * All four are nullable on purpose — mail synced in from Gmail has no Genosyn
 * author, and drafts written before this shipped stay unattributed rather than
 * being backfilled with a guess.
 */
export class MailDraftAttribution1784836230876 implements MigrationInterface {
  name = "MailDraftAttribution1784836230876";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mail_messages" ADD "createdByUserId" character varying`);
    await queryRunner.query(
      `ALTER TABLE "mail_messages" ADD "createdByEmployeeId" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "mail_messages" ADD "createdByRoutineId" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "mail_messages" ADD "createdByRunId" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mail_messages" DROP COLUMN "createdByRunId"`);
    await queryRunner.query(`ALTER TABLE "mail_messages" DROP COLUMN "createdByRoutineId"`);
    await queryRunner.query(`ALTER TABLE "mail_messages" DROP COLUMN "createdByEmployeeId"`);
    await queryRunner.query(`ALTER TABLE "mail_messages" DROP COLUMN "createdByUserId"`);
  }
}
