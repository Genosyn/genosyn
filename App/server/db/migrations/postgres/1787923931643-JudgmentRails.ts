import { MigrationInterface, QueryRunner } from "typeorm";

export class JudgmentRails1787923931643 implements MigrationInterface {
    name = 'JudgmentRails1787923931643'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "budgets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "amountMinor" integer NOT NULL, "currency" character varying NOT NULL DEFAULT 'USD', "connectionId" character varying, "employeeId" character varying, "enabled" boolean NOT NULL DEFAULT true, "lastExhaustedNotifiedAt" TIMESTAMP WITH TIME ZONE, "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9c8a51748f82387644b773da482" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_84515b4a329517d94d1669395e" ON "budgets" ("companyId", "enabled") `);
        await queryRunner.query(`CREATE TABLE "company_policies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "title" character varying NOT NULL, "body" text NOT NULL DEFAULT '', "blockedRecipientDomains" text NOT NULL DEFAULT '', "forbiddenTools" text NOT NULL DEFAULT '', "sortOrder" integer NOT NULL DEFAULT '0', "enabled" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a9ab5f754b8a9769e39b127f89e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9f05cc32457df207b7818a9bcf" ON "company_policies" ("companyId", "enabled") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_9f05cc32457df207b7818a9bcf"`);
        await queryRunner.query(`DROP TABLE "company_policies"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_84515b4a329517d94d1669395e"`);
        await queryRunner.query(`DROP TABLE "budgets"`);
    }

}
