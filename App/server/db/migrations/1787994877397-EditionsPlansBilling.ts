import { MigrationInterface, QueryRunner } from "typeorm";

export class EditionsPlansBilling1787994877397 implements MigrationInterface {
    name = 'EditionsPlansBilling1787994877397'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "company_billing" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "plan" varchar NOT NULL DEFAULT ('free'), "stripeCustomerId" varchar, "stripeSubscriptionId" varchar, "stripeSubscriptionItemId" varchar, "status" varchar, "seatCount" integer, "currentPeriodEnd" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3368a3511f1be8248f37a89f46" ON "company_billing" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "company_sso" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "provider" varchar NOT NULL DEFAULT ('google'), "displayName" varchar NOT NULL DEFAULT (''), "issuer" varchar NOT NULL DEFAULT (''), "clientId" varchar NOT NULL DEFAULT (''), "encryptedClientSecret" varchar NOT NULL DEFAULT (''), "autoJoin" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d7c2cada13a62bd3e696d09574" ON "company_sso" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "enterprise_licenses" ("id" varchar PRIMARY KEY NOT NULL, "companyName" varchar NOT NULL, "email" varchar, "expiresAt" datetime NOT NULL, "seats" integer, "evaluation" boolean NOT NULL DEFAULT (0), "keyPreview" varchar NOT NULL, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "enterprise_licenses"`);
        await queryRunner.query(`DROP INDEX "IDX_d7c2cada13a62bd3e696d09574"`);
        await queryRunner.query(`DROP TABLE "company_sso"`);
        await queryRunner.query(`DROP INDEX "IDX_3368a3511f1be8248f37a89f46"`);
        await queryRunner.query(`DROP TABLE "company_billing"`);
    }

}
