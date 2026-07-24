import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `VendorCredits1784881723675` migration —
 * the vendor_credits / vendor_credit_lines / vendor_credit_applications /
 * vendor_refunds tables plus bills.creditedCents (Phase H, AP mirror).
 *
 * Postgres adds the bills column directly (sqlite rebuilt the table). Index
 * names are byte-for-byte from the sqlite migration; PK names were computed
 * with the TypeORM naming strategy verified against existing tables — no drift.
 */
export class VendorCredits1784881723676 implements MigrationInterface {
  name = "VendorCredits1784881723676";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bills" ADD "creditedCents" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(
      `CREATE TABLE "vendor_credits" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "vendorId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'issued', "numberSeq" integer NOT NULL DEFAULT '0', "number" character varying NOT NULL DEFAULT '', "slug" character varying NOT NULL, "sourceBillId" character varying, "currency" character varying NOT NULL DEFAULT 'USD', "subtotalCents" integer NOT NULL DEFAULT '0', "taxCents" integer NOT NULL DEFAULT '0', "totalCents" integer NOT NULL DEFAULT '0', "homeSubtotalCents" integer NOT NULL DEFAULT '0', "homeTaxCents" integer NOT NULL DEFAULT '0', "homeTotalCents" integer NOT NULL DEFAULT '0', "appliedCents" integer NOT NULL DEFAULT '0', "homeAppliedCents" integer NOT NULL DEFAULT '0', "refundedCents" integer NOT NULL DEFAULT '0', "homeRefundedCents" integer NOT NULL DEFAULT '0', "reason" text NOT NULL DEFAULT '', "notes" text NOT NULL DEFAULT '', "issueDate" TIMESTAMP WITH TIME ZONE NOT NULL, "createdById" character varying, "issuedAt" TIMESTAMP WITH TIME ZONE, "voidedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8256cae650819004f3da5714c9d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f04dafe5254d98eaeb2efb985f" ON "vendor_credits" ("companyId", "slug") `);
    await queryRunner.query(`CREATE INDEX "IDX_96585f084b602d25d169ed412c" ON "vendor_credits" ("companyId", "sourceBillId") `);
    await queryRunner.query(`CREATE INDEX "IDX_d594919b528133b8eeb4bcf5a3" ON "vendor_credits" ("companyId", "vendorId") `);
    await queryRunner.query(`CREATE INDEX "IDX_211ecfaab56d2d16b75d8c3e90" ON "vendor_credits" ("companyId") `);
    await queryRunner.query(
      `CREATE TABLE "vendor_credit_lines" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "creditId" character varying NOT NULL, "expenseAccountId" character varying, "description" character varying NOT NULL, "quantity" double precision NOT NULL DEFAULT '1', "unitPriceCents" integer NOT NULL DEFAULT '0', "taxRateId" character varying, "taxName" character varying NOT NULL DEFAULT '', "taxPercent" double precision NOT NULL DEFAULT '0', "taxInclusive" boolean NOT NULL DEFAULT false, "lineSubtotalCents" integer NOT NULL DEFAULT '0', "lineTaxCents" integer NOT NULL DEFAULT '0', "lineTotalCents" integer NOT NULL DEFAULT '0', "homeSubtotalCents" integer NOT NULL DEFAULT '0', "sortOrder" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_51d77cf242f578ea2a39661321c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_ac57f9b19ede57c093bff06293" ON "vendor_credit_lines" ("creditId") `);
    await queryRunner.query(
      `CREATE TABLE "vendor_credit_applications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "creditId" character varying NOT NULL, "billId" character varying NOT NULL, "amountCents" integer NOT NULL, "apCents" integer NOT NULL, "creditCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT '0', "appliedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdById" character varying, "reversedAt" TIMESTAMP WITH TIME ZONE, "reversedById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d2e116f65d95100062174428f50" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_13c040643556fb7f2805e322fa" ON "vendor_credit_applications" ("billId") `);
    await queryRunner.query(`CREATE INDEX "IDX_c59ee63aa77ad1351133ab0dcb" ON "vendor_credit_applications" ("creditId") `);
    await queryRunner.query(`CREATE INDEX "IDX_7b407b8fdfa6df95bee9f0dad3" ON "vendor_credit_applications" ("companyId") `);
    await queryRunner.query(
      `CREATE TABLE "vendor_refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "creditId" character varying NOT NULL, "amountCents" integer NOT NULL, "creditCents" integer NOT NULL, "bankCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT '0', "currency" character varying NOT NULL, "bankAccountId" character varying NOT NULL, "refundedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "method" character varying NOT NULL DEFAULT '', "reference" character varying NOT NULL DEFAULT '', "notes" text NOT NULL DEFAULT '', "createdById" character varying, "reversedAt" TIMESTAMP WITH TIME ZONE, "reversedById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d1e2813cecee93f92cbc6c20057" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_f3dc03f5879fe237586d83aae4" ON "vendor_refunds" ("creditId") `);
    await queryRunner.query(`CREATE INDEX "IDX_4d2896de218e1599555c296ba1" ON "vendor_refunds" ("companyId") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_4d2896de218e1599555c296ba1"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f3dc03f5879fe237586d83aae4"`);
    await queryRunner.query(`DROP TABLE "vendor_refunds"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_7b407b8fdfa6df95bee9f0dad3"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_c59ee63aa77ad1351133ab0dcb"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_13c040643556fb7f2805e322fa"`);
    await queryRunner.query(`DROP TABLE "vendor_credit_applications"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ac57f9b19ede57c093bff06293"`);
    await queryRunner.query(`DROP TABLE "vendor_credit_lines"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_211ecfaab56d2d16b75d8c3e90"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d594919b528133b8eeb4bcf5a3"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_96585f084b602d25d169ed412c"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f04dafe5254d98eaeb2efb985f"`);
    await queryRunner.query(`DROP TABLE "vendor_credits"`);
    await queryRunner.query(`ALTER TABLE "bills" DROP COLUMN "creditedCents"`);
  }
}
