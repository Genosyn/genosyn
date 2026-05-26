import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerContacts1781700000000 implements MigrationInterface {
    name = 'CustomerContacts1781700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_contacts" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerId" varchar NOT NULL, "name" varchar NOT NULL, "email" varchar NOT NULL DEFAULT (''), "phone" varchar NOT NULL DEFAULT (''), "role" varchar NOT NULL DEFAULT (''), "isPrimary" boolean NOT NULL DEFAULT (0), "sortOrder" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_3fdc734bc052fa246e3f8863e2" ON "customer_contacts" ("customerId", "sortOrder") `);
        await queryRunner.query(`CREATE INDEX "IDX_b13b378eb8eb28736fb8cc1195" ON "customer_contacts" ("companyId", "customerId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b13b378eb8eb28736fb8cc1195"`);
        await queryRunner.query(`DROP INDEX "IDX_3fdc734bc052fa246e3f8863e2"`);
        await queryRunner.query(`DROP TABLE "customer_contacts"`);
    }

}
