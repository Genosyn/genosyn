import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `EmployeeFinanceGrant1784808250831`
 * migration. The Postgres stream is a squashed initial snapshot plus tail
 * deltas (see server/db/migrations/postgres/) — a new table added after
 * PostgresInitial lands as its own delta here rather than editing the
 * snapshot. Index names are byte-for-byte identical to the sqlite migration
 * (TypeORM derives them from a hash of table + columns, dialect-independent);
 * the PK constraint name matches TypeORM's DefaultNamingStrategy so a future
 * `migration:generate` on Postgres sees no drift.
 */
export class EmployeeFinanceGrant1784808250832 implements MigrationInterface {
  name = "EmployeeFinanceGrant1784808250832";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employee_finance_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'read', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_85a750cda9a5bd275dfa591c64f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_1f8bfe17fff40760b450f3be01" ON "employee_finance_grants" ("employeeId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_94ac76ea9914f1a032fa4ef8c8" ON "employee_finance_grants" ("companyId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_94ac76ea9914f1a032fa4ef8c8"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_1f8bfe17fff40760b450f3be01"`);
    await queryRunner.query(`DROP TABLE "employee_finance_grants"`);
  }
}
