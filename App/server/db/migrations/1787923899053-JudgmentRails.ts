import { MigrationInterface, QueryRunner } from "typeorm";

export class JudgmentRails1787923899053 implements MigrationInterface {
    name = 'JudgmentRails1787923899053'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "budgets" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "amountMinor" integer NOT NULL, "currency" varchar NOT NULL DEFAULT ('USD'), "connectionId" varchar, "employeeId" varchar, "enabled" boolean NOT NULL DEFAULT (1), "lastExhaustedNotifiedAt" datetime, "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_84515b4a329517d94d1669395e" ON "budgets" ("companyId", "enabled") `);
        await queryRunner.query(`CREATE TABLE "company_policies" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "body" text NOT NULL DEFAULT (''), "blockedRecipientDomains" text NOT NULL DEFAULT (''), "forbiddenTools" text NOT NULL DEFAULT (''), "sortOrder" integer NOT NULL DEFAULT (0), "enabled" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_9f05cc32457df207b7818a9bcf" ON "company_policies" ("companyId", "enabled") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9f05cc32457df207b7818a9bcf"`);
        await queryRunner.query(`DROP TABLE "company_policies"`);
        await queryRunner.query(`DROP INDEX "IDX_84515b4a329517d94d1669395e"`);
        await queryRunner.query(`DROP TABLE "budgets"`);
    }

}
