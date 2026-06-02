import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Prefix every already-issued invoice / estimate display number with the
 * uppercased customer slug.
 *
 * Before this migration two customers both showed `INV-0001` / `EST-0001`
 * in the list and the only way to tell them apart was the URL slug. After
 * it, the display number itself carries the customer slug —
 * `ACME-CORP-INV-0001`, `GLOBEX-EST-0001` — matching the format the issue
 * path now mints (see services/finance.ts + services/estimates.ts, which
 * pass `customer.slug` into lib/money.ts > formatInvoiceNumber /
 * formatEstimateNumber).
 *
 * This is a pure DATA migration — there is no schema change — so it is
 * hand-written rather than generated. TypeORM's `migration:generate` only
 * diffs the schema and would emit an empty file here (see AGENTS.md §7).
 * The SQL is deliberately:
 *   - dialect-portable (UPPER, ||, SUBSTR, LENGTH, LIKE, correlated
 *     subqueries) so it runs unchanged on both SQLite and Postgres, and
 *   - parameter-free, so it doesn't depend on the driver's placeholder
 *     syntax (`?` for better-sqlite3 vs `$1` for pg).
 *
 * Idempotent: the `LIKE 'INV-%'` / `LIKE 'EST-%'` guards match only the
 * bare un-prefixed shape, so a re-run is a no-op (a slug-prefixed number
 * starts with the slug, not `INV-`/`EST-`). Drafts (`number = ''`) and any
 * rows whose customer was hard-deleted are left untouched.
 */
export class PrefixDocNumbersWithCustomerSlug1782000000000
  implements MigrationInterface
{
  name = "PrefixDocNumbersWithCustomerSlug1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "invoices"
      SET "number" = UPPER((
        SELECT "slug" FROM "customers"
        WHERE "customers"."id" = "invoices"."customerId"
      )) || '-' || "number"
      WHERE "number" LIKE 'INV-%'
        AND EXISTS (
          SELECT 1 FROM "customers"
          WHERE "customers"."id" = "invoices"."customerId"
        )
    `);
    await queryRunner.query(`
      UPDATE "estimates"
      SET "number" = UPPER((
        SELECT "slug" FROM "customers"
        WHERE "customers"."id" = "estimates"."customerId"
      )) || '-' || "number"
      WHERE "number" LIKE 'EST-%'
        AND EXISTS (
          SELECT 1 FROM "customers"
          WHERE "customers"."id" = "estimates"."customerId"
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Strip the `<SLUG>-` prefix this migration added, restoring the bare
    // `INV-####` / `EST-####` form. The strip length is computed from the
    // customer slug so slugs that themselves contain hyphens (`acme-corp`)
    // round-trip correctly, and the `<SLUG>-INV-%` / `<SLUG>-EST-%` guard
    // means only numbers this migration actually rewrote are touched.
    await queryRunner.query(`
      UPDATE "invoices"
      SET "number" = SUBSTR("number", LENGTH(UPPER((
        SELECT "slug" FROM "customers"
        WHERE "customers"."id" = "invoices"."customerId"
      )) || '-') + 1)
      WHERE EXISTS (
          SELECT 1 FROM "customers"
          WHERE "customers"."id" = "invoices"."customerId"
        )
        AND "number" LIKE UPPER((
          SELECT "slug" FROM "customers"
          WHERE "customers"."id" = "invoices"."customerId"
        )) || '-INV-%'
    `);
    await queryRunner.query(`
      UPDATE "estimates"
      SET "number" = SUBSTR("number", LENGTH(UPPER((
        SELECT "slug" FROM "customers"
        WHERE "customers"."id" = "estimates"."customerId"
      )) || '-') + 1)
      WHERE EXISTS (
          SELECT 1 FROM "customers"
          WHERE "customers"."id" = "estimates"."customerId"
        )
        AND "number" LIKE UPPER((
          SELECT "slug" FROM "customers"
          WHERE "customers"."id" = "estimates"."customerId"
        )) || '-EST-%'
    `);
  }
}
