import { MigrationInterface, QueryRunner } from "typeorm";

export class EstimateArchive1791883996384 implements MigrationInterface {
    name = 'EstimateArchive1791883996384'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a369800c9ccabeb4e8eb527d52"`);
        await queryRunner.query(`DROP INDEX "IDX_4b554f95e27e5ed7ef3c8a8401"`);
        await queryRunner.query(`DROP INDEX "IDX_e7147292a569a965ecb2134236"`);
        await queryRunner.query(`DROP INDEX "IDX_50e84f6fc9a247ab896845267d"`);
        await queryRunner.query(`CREATE TABLE "temporary_estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "subsidiaryId" varchar, "issuerSnapshot" text, "archivedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_estimates"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot" FROM "estimates"`);
        await queryRunner.query(`DROP TABLE "estimates"`);
        await queryRunner.query(`ALTER TABLE "temporary_estimates" RENAME TO "estimates"`);
        await queryRunner.query(`CREATE INDEX "IDX_a369800c9ccabeb4e8eb527d52" ON "estimates" ("companyId", "numberSeq") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b554f95e27e5ed7ef3c8a8401" ON "estimates" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7147292a569a965ecb2134236" ON "estimates" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50e84f6fc9a247ab896845267d" ON "estimates" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_a94ef2010066bdd4de59c22062" ON "estimates" ("companyId", "archivedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a94ef2010066bdd4de59c22062"`);
        await queryRunner.query(`DROP INDEX "IDX_50e84f6fc9a247ab896845267d"`);
        await queryRunner.query(`DROP INDEX "IDX_e7147292a569a965ecb2134236"`);
        await queryRunner.query(`DROP INDEX "IDX_4b554f95e27e5ed7ef3c8a8401"`);
        await queryRunner.query(`DROP INDEX "IDX_a369800c9ccabeb4e8eb527d52"`);
        await queryRunner.query(`ALTER TABLE "estimates" RENAME TO "temporary_estimates"`);
        await queryRunner.query(`CREATE TABLE "estimates" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "slug" varchar NOT NULL, "numberSeq" integer NOT NULL DEFAULT (0), "number" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('draft'), "issueDate" datetime NOT NULL, "validUntil" datetime NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "subtotalCents" integer NOT NULL DEFAULT (0), "taxCents" integer NOT NULL DEFAULT (0), "totalCents" integer NOT NULL DEFAULT (0), "notes" text NOT NULL DEFAULT (''), "footer" text NOT NULL DEFAULT (''), "sentAt" datetime, "acceptedAt" datetime, "declinedAt" datetime, "voidedAt" datetime, "invoiceId" varchar, "convertedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "subsidiaryId" varchar, "issuerSnapshot" text)`);
        await queryRunner.query(`INSERT INTO "estimates"("id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot") SELECT "id", "companyId", "customerId", "slug", "numberSeq", "number", "status", "issueDate", "validUntil", "currency", "subtotalCents", "taxCents", "totalCents", "notes", "footer", "sentAt", "acceptedAt", "declinedAt", "voidedAt", "invoiceId", "convertedAt", "createdById", "createdAt", "updatedAt", "subsidiaryId", "issuerSnapshot" FROM "temporary_estimates"`);
        await queryRunner.query(`DROP TABLE "temporary_estimates"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_50e84f6fc9a247ab896845267d" ON "estimates" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_e7147292a569a965ecb2134236" ON "estimates" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b554f95e27e5ed7ef3c8a8401" ON "estimates" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a369800c9ccabeb4e8eb527d52" ON "estimates" ("companyId", "numberSeq") `);
    }

}
