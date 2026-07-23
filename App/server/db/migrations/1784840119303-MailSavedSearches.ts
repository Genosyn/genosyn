import { MigrationInterface, QueryRunner } from "typeorm";

export class MailSavedSearches1784840119303 implements MigrationInterface {
    name = 'MailSavedSearches1784840119303'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_saved_searches" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "userId" varchar NOT NULL, "accountId" varchar NOT NULL, "name" varchar NOT NULL, "query" text NOT NULL, "sortOrder" float NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_1ec8dff50f0fa4034d428f2dfa" ON "mail_saved_searches" ("companyId", "userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_67d2b408c487531fc1d030363b" ON "mail_saved_searches" ("userId", "accountId", "sortOrder") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_67d2b408c487531fc1d030363b"`);
        await queryRunner.query(`DROP INDEX "IDX_1ec8dff50f0fa4034d428f2dfa"`);
        await queryRunner.query(`DROP TABLE "mail_saved_searches"`);
    }

}
