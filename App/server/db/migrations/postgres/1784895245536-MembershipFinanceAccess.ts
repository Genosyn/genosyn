import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `MembershipFinanceAccess1784895245535`
 * migration — adds `memberships.financeAccess` (M33 A4, the per-member finance
 * access level).
 *
 * sqlite has to rebuild the table to add a NOT NULL column with a default;
 * Postgres adds it in place. Existing rows take the `full` default, so the new
 * role changes nothing until an owner dials someone down.
 */
export class MembershipFinanceAccess1784895245536 implements MigrationInterface {
  name = "MembershipFinanceAccess1784895245536";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "memberships" ADD "financeAccess" character varying NOT NULL DEFAULT 'full'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "memberships" DROP COLUMN "financeAccess"`);
  }
}
