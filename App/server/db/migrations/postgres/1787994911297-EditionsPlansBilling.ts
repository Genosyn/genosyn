import { MigrationInterface, QueryRunner } from "typeorm";

export class EditionsPlansBilling1787994911297 implements MigrationInterface {
    name = 'EditionsPlansBilling1787994911297'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "company_billing" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "plan" character varying NOT NULL DEFAULT 'free', "stripeCustomerId" character varying, "stripeSubscriptionId" character varying, "stripeSubscriptionItemId" character varying, "status" character varying, "seatCount" integer, "currentPeriodEnd" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5a054d783b1c1129ecd6282ccdd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3368a3511f1be8248f37a89f46" ON "company_billing" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "company_sso" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "provider" character varying NOT NULL DEFAULT 'google', "displayName" character varying NOT NULL DEFAULT '', "issuer" character varying NOT NULL DEFAULT '', "clientId" character varying NOT NULL DEFAULT '', "encryptedClientSecret" character varying NOT NULL DEFAULT '', "autoJoin" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4d1bea05f66bd4f90b46b31c4b5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d7c2cada13a62bd3e696d09574" ON "company_sso" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "enterprise_licenses" ("id" character varying NOT NULL, "companyName" character varying NOT NULL, "email" character varying, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "seats" integer, "evaluation" boolean NOT NULL DEFAULT false, "keyPreview" character varying NOT NULL, "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e1f0328ab40750e2acef6738527" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "enterprise_licenses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d7c2cada13a62bd3e696d09574"`);
        await queryRunner.query(`DROP TABLE "company_sso"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3368a3511f1be8248f37a89f46"`);
        await queryRunner.query(`DROP TABLE "company_billing"`);
    }

}
