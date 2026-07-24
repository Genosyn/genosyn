import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerRefunds1784879604198 implements MigrationInterface {
    name = 'CustomerRefunds1784879604198'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_refunds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "creditId" varchar NOT NULL, "amountCents" integer NOT NULL, "creditCents" integer NOT NULL, "bankCents" integer NOT NULL, "fxCents" integer NOT NULL DEFAULT (0), "currency" varchar NOT NULL, "bankAccountId" varchar NOT NULL, "refundedAt" datetime NOT NULL, "method" varchar NOT NULL DEFAULT (''), "reference" varchar NOT NULL DEFAULT (''), "notes" text NOT NULL DEFAULT (''), "createdById" varchar, "reversedAt" datetime, "reversedById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f5c593be1d654f459da37ebf95" ON "customer_refunds" ("creditId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f27853323f768a370d4cbef874" ON "customer_refunds" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f27853323f768a370d4cbef874"`);
        await queryRunner.query(`DROP INDEX "IDX_f5c593be1d654f459da37ebf95"`);
        await queryRunner.query(`DROP TABLE "customer_refunds"`);
    }

}
