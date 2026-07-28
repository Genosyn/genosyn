import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueGapClosure1785224645402 implements MigrationInterface {
    name = 'RevenueGapClosure1785224645402'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "revenue_firmographic_lookups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "connectionId" varchar NOT NULL, "provider" varchar NOT NULL, "providerRecordId" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL, "normalizedSnapshotJson" text NOT NULL DEFAULT ('{}'), "confidence" integer NOT NULL DEFAULT (0), "lastAttemptedAt" datetime NOT NULL, "lastMatchedAt" datetime, "observedAt" datetime, "lastError" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7a50228bc0a1f09399e743f3b6" ON "revenue_firmographic_lookups" ("companyId", "status", "lastAttemptedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_539725763547946eaca6053f49" ON "revenue_firmographic_lookups" ("companyId", "customerId", "connectionId") `);
        await queryRunner.query(`DROP INDEX "IDX_957b8dd8c17aac17229369e91c"`);
        await queryRunner.query(`DROP INDEX "IDX_34d1051b5ebae7aaeb9c54ad52"`);
        await queryRunner.query(`DROP INDEX "IDX_e8ba264e557c27ffe461eb6c69"`);
        await queryRunner.query(`DROP INDEX "IDX_8bc655492a3f2878a887a75b86"`);
        await queryRunner.query(`CREATE TABLE "temporary_customers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "billingAddress" text NOT NULL DEFAULT (''), "shippingAddress" text NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "annualContractValueCents" integer NOT NULL DEFAULT (0), "accountStatus" varchar NOT NULL DEFAULT ('customer'), "domain" varchar NOT NULL DEFAULT (''), "websiteUrl" varchar NOT NULL DEFAULT (''), "industry" varchar NOT NULL DEFAULT (''), "employeeCount" integer NOT NULL DEFAULT (0), "ownerId" varchar, "ownerEmployeeId" varchar, "headquartersAddress" text NOT NULL DEFAULT (''), "parentCompanyName" varchar NOT NULL DEFAULT (''), "parentCompanyDomain" varchar NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_customers"("id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt", "annualContractValueCents", "accountStatus", "domain", "websiteUrl", "industry", "employeeCount", "ownerId", "ownerEmployeeId") SELECT "id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt", "annualContractValueCents", "accountStatus", "domain", "websiteUrl", "industry", "employeeCount", "ownerId", "ownerEmployeeId" FROM "customers"`);
        await queryRunner.query(`DROP TABLE "customers"`);
        await queryRunner.query(`ALTER TABLE "temporary_customers" RENAME TO "customers"`);
        await queryRunner.query(`CREATE INDEX "IDX_957b8dd8c17aac17229369e91c" ON "customers" ("companyId", "accountStatus") `);
        await queryRunner.query(`CREATE INDEX "IDX_34d1051b5ebae7aaeb9c54ad52" ON "customers" ("companyId", "domain") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e8ba264e557c27ffe461eb6c69" ON "customers" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_8bc655492a3f2878a887a75b86" ON "customers" ("companyId", "archivedAt") `);
        await queryRunner.query(`DROP INDEX "IDX_e3b13b6afcb0e35e93da44cbf3"`);
        await queryRunner.query(`DROP INDEX "IDX_a7cf5cf8c67bbbb8c9acb93eea"`);
        await queryRunner.query(`CREATE TABLE "temporary_revenue_import_batches" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "resourceType" varchar NOT NULL, "sourceKind" varchar NOT NULL, "sourceLabel" varchar NOT NULL DEFAULT (''), "sourceBaseId" varchar, "sourceTableId" varchar, "status" varchar NOT NULL, "mappingJson" text NOT NULL, "rowMapJson" text NOT NULL, "createdIdsJson" text NOT NULL, "reportJson" text NOT NULL, "rolledBackAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "sourceConnectionId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_revenue_import_batches"("id", "companyId", "resourceType", "sourceKind", "sourceLabel", "sourceBaseId", "sourceTableId", "status", "mappingJson", "rowMapJson", "createdIdsJson", "reportJson", "rolledBackAt", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "resourceType", "sourceKind", "sourceLabel", "sourceBaseId", "sourceTableId", "status", "mappingJson", "rowMapJson", "createdIdsJson", "reportJson", "rolledBackAt", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt" FROM "revenue_import_batches"`);
        await queryRunner.query(`DROP TABLE "revenue_import_batches"`);
        await queryRunner.query(`ALTER TABLE "temporary_revenue_import_batches" RENAME TO "revenue_import_batches"`);
        await queryRunner.query(`CREATE INDEX "IDX_e3b13b6afcb0e35e93da44cbf3" ON "revenue_import_batches" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a7cf5cf8c67bbbb8c9acb93eea" ON "revenue_import_batches" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a7cf5cf8c67bbbb8c9acb93eea"`);
        await queryRunner.query(`DROP INDEX "IDX_e3b13b6afcb0e35e93da44cbf3"`);
        await queryRunner.query(`ALTER TABLE "revenue_import_batches" RENAME TO "temporary_revenue_import_batches"`);
        await queryRunner.query(`CREATE TABLE "revenue_import_batches" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "resourceType" varchar NOT NULL, "sourceKind" varchar NOT NULL, "sourceLabel" varchar NOT NULL DEFAULT (''), "sourceBaseId" varchar, "sourceTableId" varchar, "status" varchar NOT NULL, "mappingJson" text NOT NULL, "rowMapJson" text NOT NULL, "createdIdsJson" text NOT NULL, "reportJson" text NOT NULL, "rolledBackAt" datetime, "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "revenue_import_batches"("id", "companyId", "resourceType", "sourceKind", "sourceLabel", "sourceBaseId", "sourceTableId", "status", "mappingJson", "rowMapJson", "createdIdsJson", "reportJson", "rolledBackAt", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "resourceType", "sourceKind", "sourceLabel", "sourceBaseId", "sourceTableId", "status", "mappingJson", "rowMapJson", "createdIdsJson", "reportJson", "rolledBackAt", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt" FROM "temporary_revenue_import_batches"`);
        await queryRunner.query(`DROP TABLE "temporary_revenue_import_batches"`);
        await queryRunner.query(`CREATE INDEX "IDX_a7cf5cf8c67bbbb8c9acb93eea" ON "revenue_import_batches" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3b13b6afcb0e35e93da44cbf3" ON "revenue_import_batches" ("companyId", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_8bc655492a3f2878a887a75b86"`);
        await queryRunner.query(`DROP INDEX "IDX_e8ba264e557c27ffe461eb6c69"`);
        await queryRunner.query(`DROP INDEX "IDX_34d1051b5ebae7aaeb9c54ad52"`);
        await queryRunner.query(`DROP INDEX "IDX_957b8dd8c17aac17229369e91c"`);
        await queryRunner.query(`ALTER TABLE "customers" RENAME TO "temporary_customers"`);
        await queryRunner.query(`CREATE TABLE "customers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "billingAddress" text NOT NULL DEFAULT (''), "shippingAddress" text NOT NULL DEFAULT (''), "taxNumber" varchar NOT NULL DEFAULT (''), "currency" varchar NOT NULL DEFAULT ('USD'), "notes" text NOT NULL DEFAULT (''), "archivedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "annualContractValueCents" integer NOT NULL DEFAULT (0), "accountStatus" varchar NOT NULL DEFAULT ('customer'), "domain" varchar NOT NULL DEFAULT (''), "websiteUrl" varchar NOT NULL DEFAULT (''), "industry" varchar NOT NULL DEFAULT (''), "employeeCount" integer NOT NULL DEFAULT (0), "ownerId" varchar, "ownerEmployeeId" varchar)`);
        await queryRunner.query(`INSERT INTO "customers"("id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt", "annualContractValueCents", "accountStatus", "domain", "websiteUrl", "industry", "employeeCount", "ownerId", "ownerEmployeeId") SELECT "id", "companyId", "name", "slug", "email", "phone", "billingAddress", "shippingAddress", "taxNumber", "currency", "notes", "archivedAt", "createdById", "createdAt", "updatedAt", "annualContractValueCents", "accountStatus", "domain", "websiteUrl", "industry", "employeeCount", "ownerId", "ownerEmployeeId" FROM "temporary_customers"`);
        await queryRunner.query(`DROP TABLE "temporary_customers"`);
        await queryRunner.query(`CREATE INDEX "IDX_8bc655492a3f2878a887a75b86" ON "customers" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e8ba264e557c27ffe461eb6c69" ON "customers" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_34d1051b5ebae7aaeb9c54ad52" ON "customers" ("companyId", "domain") `);
        await queryRunner.query(`CREATE INDEX "IDX_957b8dd8c17aac17229369e91c" ON "customers" ("companyId", "accountStatus") `);
        await queryRunner.query(`DROP INDEX "IDX_539725763547946eaca6053f49"`);
        await queryRunner.query(`DROP INDEX "IDX_7a50228bc0a1f09399e743f3b6"`);
        await queryRunner.query(`DROP TABLE "revenue_firmographic_lookups"`);
    }

}
