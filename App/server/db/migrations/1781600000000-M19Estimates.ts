import { MigrationInterface, QueryRunner } from "typeorm";

export class M19Estimates1781600000000 implements MigrationInterface {
    name = 'M19Estimates1781600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a369800c9ccabeb4e8eb527d52" ON "estimates" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b554f95e27e5ed7ef3c8a8401" ON "estimates" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7147292a569a965ecb2134236" ON "estimates" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50e84f6fc9a247ab896845267d" ON "estimates" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "estimate_line_items" ("id" varchar PRIMARY KEY NOT NULL, "estimateId" varchar NOT NULL, "productId" varchar, "description" varchar NOT NULL, "quantity" real NOT NULL DEFAULT (1), "unitPriceCents" integer NOT NULL DEFAULT (0), "taxRateId" varchar, "taxName" varchar NOT NULL DEFAULT (''), "taxPercent" real NOT NULL DEFAULT (0), "taxInclusive" boolean NOT NULL DEFAULT (0), "lineSubtotalCents" integer NOT NULL DEFAULT (0), "lineTaxCents" integer NOT NULL DEFAULT (0), "lineTotalCents" integer NOT NULL DEFAULT (0), "sortOrder" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`CREATE INDEX "IDX_a999b1ff0276fd479644a45077" ON "estimate_line_items" ("estimateId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_a999b1ff0276fd479644a45077"`);
        await queryRunner.query(`DROP TABLE "estimate_line_items"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_50e84f6fc9a247ab896845267d"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e7147292a569a965ecb2134236"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_4b554f95e27e5ed7ef3c8a8401"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_a369800c9ccabeb4e8eb527d52"`);
        await queryRunner.query(`DROP TABLE "estimates"`);
    }

}
