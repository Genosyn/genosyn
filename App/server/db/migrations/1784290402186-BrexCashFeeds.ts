import { MigrationInterface, QueryRunner } from "typeorm";

export class BrexCashFeeds1784290402186 implements MigrationInterface {
    name = 'BrexCashFeeds1784290402186'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_8981f153643ea13187e82d41e3"`);
        await queryRunner.query(`DROP INDEX "IDX_b5bc8dc3001a897c4d50e05720"`);
        await queryRunner.query(`CREATE TABLE "temporary_bank_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar, "accountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "externalAccountId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_bank_feeds"("id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt" FROM "bank_feeds"`);
        await queryRunner.query(`DROP TABLE "bank_feeds"`);
        await queryRunner.query(`ALTER TABLE "temporary_bank_feeds" RENAME TO "bank_feeds"`);
        await queryRunner.query(`CREATE INDEX "IDX_8981f153643ea13187e82d41e3" ON "bank_feeds" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b5bc8dc3001a897c4d50e05720" ON "bank_feeds" ("companyId", "archivedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b5bc8dc3001a897c4d50e05720"`);
        await queryRunner.query(`DROP INDEX "IDX_8981f153643ea13187e82d41e3"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" RENAME TO "temporary_bank_feeds"`);
        await queryRunner.query(`CREATE TABLE "bank_feeds" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "kind" varchar NOT NULL, "connectionId" varchar, "accountId" varchar NOT NULL, "lastSyncAt" datetime, "archivedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "bank_feeds"("id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "kind", "connectionId", "accountId", "lastSyncAt", "archivedAt", "createdAt", "updatedAt" FROM "temporary_bank_feeds"`);
        await queryRunner.query(`DROP TABLE "temporary_bank_feeds"`);
        await queryRunner.query(`CREATE INDEX "IDX_b5bc8dc3001a897c4d50e05720" ON "bank_feeds" ("companyId", "archivedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8981f153643ea13187e82d41e3" ON "bank_feeds" ("companyId") `);
    }

}
