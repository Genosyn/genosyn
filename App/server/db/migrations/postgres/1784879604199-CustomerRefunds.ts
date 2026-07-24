import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Postgres-stream sibling of the sqlite `CustomerRefunds1784879604198`
 * migration — the customer_refunds table (Phase H cash refunds). Index names
 * are copied byte-for-byte from the sqlite migration; the PK name was computed
 * with the same TypeORM naming strategy (verified against existing tables), so
 * a future migration:generate against Postgres sees no drift.
 */
export class CustomerRefunds1784879604199 implements MigrationInterface {
  name = "CustomerRefunds1784879604199";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "customer_refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "creditId" character varying NOT NULL, "amountCents" integer NOT NULL, "creditCents" integer NOT NULL, "bankCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT '0', "currency" character varying NOT NULL, "bankAccountId" character varying NOT NULL, "refundedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "method" character varying NOT NULL DEFAULT '', "reference" character varying NOT NULL DEFAULT '', "notes" text NOT NULL DEFAULT '', "createdById" character varying, "reversedAt" TIMESTAMP WITH TIME ZONE, "reversedById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2df1dc058c7514ca78be9ca0a47" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f5c593be1d654f459da37ebf95" ON "customer_refunds" ("creditId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f27853323f768a370d4cbef874" ON "customer_refunds" ("companyId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_f27853323f768a370d4cbef874"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f5c593be1d654f459da37ebf95"`);
    await queryRunner.query(`DROP TABLE "customer_refunds"`);
  }
}
