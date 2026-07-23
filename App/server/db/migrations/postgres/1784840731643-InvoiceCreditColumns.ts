import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `InvoiceCreditColumns1784840731642`
 * migration. The Postgres stream is a squashed initial snapshot plus tail
 * deltas (see server/db/migrations/postgres/) — new columns land as their own
 * delta here rather than editing the snapshot.
 *
 * Postgres supports `ALTER TABLE … ADD COLUMN` directly, so this is a plain set
 * of adds where sqlite had to rebuild both tables and recreate every index.
 *
 * Phase H foundations: `creditedCents` / `writtenOffCents` let an invoice be
 * settled by something other than cash (a customer credit or a write-off)
 * while `paidCents` keeps meaning "cash actually collected".
 * `matchedCreditId` / `matchedRefundId` give the reconciler somewhere to point
 * when a deposit arrives or a refund leaves on the bank feed.
 */
export class InvoiceCreditColumns1784840731643 implements MigrationInterface {
  name = "InvoiceCreditColumns1784840731643";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Integer defaults are quoted to match how TypeORM emits them elsewhere in
    // this stream (see PostgresInitial's `timeoutSec integer NOT NULL DEFAULT
    // '3600'`), so a future migration:generate sees no drift.
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD "creditedCents" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD "writtenOffCents" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "bank_transactions" ADD "matchedCreditId" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "bank_transactions" ADD "matchedRefundId" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bank_transactions" DROP COLUMN "matchedRefundId"`);
    await queryRunner.query(`ALTER TABLE "bank_transactions" DROP COLUMN "matchedCreditId"`);
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "writtenOffCents"`);
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "creditedCents"`);
  }
}
