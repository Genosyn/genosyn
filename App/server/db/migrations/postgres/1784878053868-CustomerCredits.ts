import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `CustomerCredits1784878053867`
 * migration — the customer_credits, customer_credit_lines and
 * customer_credit_applications tables (Phase H credit notes + applications).
 *
 * Column types follow the Postgres snapshot's conventions. The index names are
 * copied byte-for-byte from the sqlite migration (TypeORM derives them from a
 * dialect-independent hash) and the PK names were computed with the same naming
 * strategy (verified against existing tables), so a future migration:generate
 * against Postgres sees no drift.
 */
export class CustomerCredits1784878053868 implements MigrationInterface {
  name = "CustomerCredits1784878053868";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "customer_credits" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "customerId" character varying NOT NULL, "kind" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'draft', "numberSeq" integer NOT NULL DEFAULT '0', "number" character varying NOT NULL DEFAULT '', "slug" character varying NOT NULL, "sourceInvoiceId" character varying, "currency" character varying NOT NULL DEFAULT 'USD', "subtotalCents" integer NOT NULL DEFAULT '0', "taxCents" integer NOT NULL DEFAULT '0', "totalCents" integer NOT NULL DEFAULT '0', "homeSubtotalCents" integer NOT NULL DEFAULT '0', "homeTaxCents" integer NOT NULL DEFAULT '0', "homeTotalCents" integer NOT NULL DEFAULT '0', "appliedCents" integer NOT NULL DEFAULT '0', "homeAppliedCents" integer NOT NULL DEFAULT '0', "refundedCents" integer NOT NULL DEFAULT '0', "homeRefundedCents" integer NOT NULL DEFAULT '0', "reason" text NOT NULL DEFAULT '', "notes" text NOT NULL DEFAULT '', "issueDate" TIMESTAMP WITH TIME ZONE NOT NULL, "createdById" character varying, "issuedAt" TIMESTAMP WITH TIME ZONE, "voidedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_21549f837f9a7edaa4120792a86" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_1bdf3795998d0d80ca0245244f" ON "customer_credits" ("companyId", "slug") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_698deae864a29b4c13ee921714" ON "customer_credits" ("companyId", "sourceInvoiceId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_da5b5c44a070e24b4e6efabe93" ON "customer_credits" ("companyId", "customerId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_866f402a33b312cf033602e8ce" ON "customer_credits" ("companyId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_credit_lines" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "creditId" character varying NOT NULL, "productId" character varying, "description" character varying NOT NULL, "quantity" double precision NOT NULL DEFAULT '1', "unitPriceCents" integer NOT NULL DEFAULT '0', "taxRateId" character varying, "taxName" character varying NOT NULL DEFAULT '', "taxPercent" double precision NOT NULL DEFAULT '0', "taxInclusive" boolean NOT NULL DEFAULT false, "lineSubtotalCents" integer NOT NULL DEFAULT '0', "lineTaxCents" integer NOT NULL DEFAULT '0', "lineTotalCents" integer NOT NULL DEFAULT '0', "sortOrder" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_0ad7352e92c56dbd5cde44c6a50" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c8259acf63e53c0a512297a32f" ON "customer_credit_lines" ("creditId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_credit_applications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "creditId" character varying NOT NULL, "invoiceId" character varying NOT NULL, "amountCents" integer NOT NULL, "arCents" integer NOT NULL, "creditCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT '0', "appliedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdById" character varying, "reversedAt" TIMESTAMP WITH TIME ZONE, "reversedById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_64864653b087d495c8098923935" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_56fb532608428c0f7982aa1b87" ON "customer_credit_applications" ("invoiceId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_82f84acd2774a6f7d234189f0c" ON "customer_credit_applications" ("creditId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ae713fb0e03797b75668f24147" ON "customer_credit_applications" ("companyId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_ae713fb0e03797b75668f24147"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_82f84acd2774a6f7d234189f0c"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_56fb532608428c0f7982aa1b87"`);
    await queryRunner.query(`DROP TABLE "customer_credit_applications"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_c8259acf63e53c0a512297a32f"`);
    await queryRunner.query(`DROP TABLE "customer_credit_lines"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_866f402a33b312cf033602e8ce"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_da5b5c44a070e24b4e6efabe93"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_698deae864a29b4c13ee921714"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_1bdf3795998d0d80ca0245244f"`);
    await queryRunner.query(`DROP TABLE "customer_credits"`);
  }
}
