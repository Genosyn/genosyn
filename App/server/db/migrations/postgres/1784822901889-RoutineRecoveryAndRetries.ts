import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `RoutineRecoveryAndRetries1784822901888`
 * migration. The Postgres stream is a squashed initial snapshot plus tail
 * deltas (see server/db/migrations/postgres/) — new columns land as their own
 * delta here rather than editing the snapshot.
 *
 * Postgres supports `ALTER TABLE … ADD COLUMN` directly, so this is a plain set
 * of adds where sqlite had to rebuild both tables. Index names are copied
 * byte-for-byte from the sqlite migration: TypeORM derives them from a hash of
 * table + columns, which is dialect-independent, so a future
 * `migration:generate` against Postgres sees no drift.
 */
export class RoutineRecoveryAndRetries1784822901889 implements MigrationInterface {
  name = "RoutineRecoveryAndRetries1784822901889";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "routines" ADD "catchUpPolicy" character varying NOT NULL DEFAULT 'once'`,
    );
    // Integer defaults are quoted to match how TypeORM emits them elsewhere in
    // this stream (see PostgresInitial's `timeoutSec integer NOT NULL DEFAULT
    // '3600'`), so a future migration:generate sees no drift.
    await queryRunner.query(
      `ALTER TABLE "routines" ADD "maxAttempts" integer NOT NULL DEFAULT '1'`,
    );
    await queryRunner.query(
      `ALTER TABLE "routines" ADD "retryBackoffSec" integer NOT NULL DEFAULT '60'`,
    );
    await queryRunner.query(
      `ALTER TABLE "routines" ADD "retryOnTimeout" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "runs" ADD "triggerKind" character varying NOT NULL DEFAULT 'schedule'`,
    );
    await queryRunner.query(`ALTER TABLE "runs" ADD "attempt" integer NOT NULL DEFAULT '1'`);
    await queryRunner.query(`ALTER TABLE "runs" ADD "parentRunId" character varying`);
    await queryRunner.query(`ALTER TABLE "runs" ADD "retryAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "runs" ADD "missedSlots" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(
      `CREATE INDEX "IDX_ef3c194cfdbf720e71464a3b30" ON "routines" ("enabled", "nextRunAt") `,
    );
    await queryRunner.query(`CREATE INDEX "IDX_7768e812e25e9ce2abd2a65e73" ON "runs" ("retryAt") `);
    await queryRunner.query(
      `CREATE INDEX "IDX_677c13cd57721966e5838cea2d" ON "runs" ("status", "startedAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_677c13cd57721966e5838cea2d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_7768e812e25e9ce2abd2a65e73"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ef3c194cfdbf720e71464a3b30"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "missedSlots"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "retryAt"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "parentRunId"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "attempt"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "triggerKind"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "retryOnTimeout"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "retryBackoffSec"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "maxAttempts"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "catchUpPolicy"`);
  }
}
