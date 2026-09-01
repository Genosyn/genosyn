import { MigrationInterface, QueryRunner } from "typeorm";

export class AnnualBillingInterval1788296789821 implements MigrationInterface {
    name = 'AnnualBillingInterval1788296789821'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3368a3511f1be8248f37a89f46"`);
        await queryRunner.query(`CREATE TABLE "temporary_company_billing" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "plan" varchar NOT NULL DEFAULT ('free'), "stripeCustomerId" varchar, "stripeSubscriptionId" varchar, "stripeSubscriptionItemId" varchar, "status" varchar, "seatCount" integer, "currentPeriodEnd" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "billingInterval" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_company_billing"("id", "companyId", "plan", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionItemId", "status", "seatCount", "currentPeriodEnd", "createdAt", "updatedAt") SELECT "id", "companyId", "plan", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionItemId", "status", "seatCount", "currentPeriodEnd", "createdAt", "updatedAt" FROM "company_billing"`);
        await queryRunner.query(`DROP TABLE "company_billing"`);
        await queryRunner.query(`ALTER TABLE "temporary_company_billing" RENAME TO "company_billing"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3368a3511f1be8248f37a89f46" ON "company_billing" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3368a3511f1be8248f37a89f46"`);
        await queryRunner.query(`ALTER TABLE "company_billing" RENAME TO "temporary_company_billing"`);
        await queryRunner.query(`CREATE TABLE "company_billing" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "plan" varchar NOT NULL DEFAULT ('free'), "stripeCustomerId" varchar, "stripeSubscriptionId" varchar, "stripeSubscriptionItemId" varchar, "status" varchar, "seatCount" integer, "currentPeriodEnd" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "company_billing"("id", "companyId", "plan", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionItemId", "status", "seatCount", "currentPeriodEnd", "createdAt", "updatedAt") SELECT "id", "companyId", "plan", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionItemId", "status", "seatCount", "currentPeriodEnd", "createdAt", "updatedAt" FROM "temporary_company_billing"`);
        await queryRunner.query(`DROP TABLE "temporary_company_billing"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3368a3511f1be8248f37a89f46" ON "company_billing" ("companyId") `);
    }

}
