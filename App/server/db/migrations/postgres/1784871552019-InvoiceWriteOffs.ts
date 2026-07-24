import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `InvoiceWriteOffs1784871552018`
 * migration — the invoice_write_offs table (Phase H write-offs).
 *
 * Column types follow the Postgres snapshot's conventions (character varying,
 * TIMESTAMP WITH TIME ZONE, uuid PK with uuid_generate_v4()). The PK and index
 * names are TypeORM-derived hashes of (table, columns), which are
 * dialect-independent — the two IDX names are byte-for-byte identical to the
 * sqlite migration, and the PK name was computed with the same naming strategy
 * (verified against existing tables) — so a future migration:generate against
 * Postgres sees no drift.
 */
export class InvoiceWriteOffs1784871552019 implements MigrationInterface {
  name = "InvoiceWriteOffs1784871552019";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invoice_write_offs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "invoiceId" character varying NOT NULL, "kind" character varying NOT NULL, "amountCents" integer NOT NULL, "homeCents" integer NOT NULL, "currency" character varying NOT NULL, "expenseAccountId" character varying NOT NULL, "writeOffDate" TIMESTAMP WITH TIME ZONE NOT NULL, "note" text NOT NULL DEFAULT '', "createdById" character varying, "reversedAt" TIMESTAMP WITH TIME ZONE, "reversedById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_12214b51a4271784391412558c2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_decd5f453bf50bf765358c2ffc" ON "invoice_write_offs" ("invoiceId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7635aa6cc1a6abdc934ceaa192" ON "invoice_write_offs" ("companyId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_7635aa6cc1a6abdc934ceaa192"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_decd5f453bf50bf765358c2ffc"`);
    await queryRunner.query(`DROP TABLE "invoice_write_offs"`);
  }
}
