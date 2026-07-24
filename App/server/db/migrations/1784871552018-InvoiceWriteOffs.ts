import { MigrationInterface, QueryRunner } from "typeorm";

export class InvoiceWriteOffs1784871552018 implements MigrationInterface {
    name = 'InvoiceWriteOffs1784871552018'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "invoice_write_offs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "invoiceId" varchar NOT NULL, "kind" varchar NOT NULL, "amountCents" integer NOT NULL, "homeCents" integer NOT NULL, "currency" varchar NOT NULL, "expenseAccountId" varchar NOT NULL, "writeOffDate" datetime NOT NULL, "note" text NOT NULL DEFAULT (''), "createdById" varchar, "reversedAt" datetime, "reversedById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_decd5f453bf50bf765358c2ffc" ON "invoice_write_offs" ("invoiceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7635aa6cc1a6abdc934ceaa192" ON "invoice_write_offs" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_7635aa6cc1a6abdc934ceaa192"`);
        await queryRunner.query(`DROP INDEX "IDX_decd5f453bf50bf765358c2ffc"`);
        await queryRunner.query(`DROP TABLE "invoice_write_offs"`);
    }

}
