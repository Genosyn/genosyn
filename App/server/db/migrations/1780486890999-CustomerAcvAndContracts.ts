import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerAcvAndContracts1780486890999 implements MigrationInterface {
    name = 'CustomerAcvAndContracts1780486890999'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_contracts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar, "title" varchar NOT NULL, "filename" varchar NOT NULL, "mimeType" varchar NOT NULL DEFAULT ('application/octet-stream'), "sizeBytes" bigint NOT NULL DEFAULT (0), "storageKey" varchar NOT NULL, "signedAt" datetime, "notes" text NOT NULL DEFAULT (''), "uploadedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_5e03f3c4ccc09ad001701e6a09" ON "customer_contracts" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5f1c40a6945be08a1a3a159e0" ON "customer_contracts" ("companyId", "customerId") `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e8ba264e557c27ffe461eb6c69"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_8bc655492a3f2878a887a75b86"`);
        await queryRunner.query(`CREATE TABLE "temporary_customers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "billingAddress" text NOT NULL DEFAULT (''), "shippingAddress" text NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "annualContractValueCents" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_customers"("id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt" FROM "customers"`);
        await queryRunner.query(`DROP TABLE "customers"`);
        await queryRunner.query(`ALTER TABLE "temporary_customers" RENAME TO "customers"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e8ba264e557c27ffe461eb6c69" ON "customers" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_8bc655492a3f2878a887a75b86" ON "customers" ("companyId", "archivedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_8bc655492a3f2878a887a75b86"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e8ba264e557c27ffe461eb6c69"`);
        await queryRunner.query(`ALTER TABLE "customers" RENAME TO "temporary_customers"`);
        await queryRunner.query(`CREATE TABLE "customers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "billingAddress" text NOT NULL DEFAULT (''), "shippingAddress" text NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "customers"("id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt" FROM "temporary_customers"`);
        await queryRunner.query(`DROP TABLE "temporary_customers"`);
        await queryRunner.query(`CREATE INDEX "IDX_8bc655492a3f2878a887a75b86" ON "customers" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e8ba264e557c27ffe461eb6c69" ON "customers" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_d5f1c40a6945be08a1a3a159e0"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_5e03f3c4ccc09ad001701e6a09"`);
        await queryRunner.query(`DROP TABLE "customer_contracts"`);
    }

}
