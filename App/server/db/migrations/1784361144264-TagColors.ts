import { MigrationInterface, QueryRunner } from "typeorm";

export class TagColors1784361144264 implements MigrationInterface {
    name = 'TagColors1784361144264'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_40d3284c7c060f75caee62cf94"`);
        await queryRunner.query(`DROP INDEX "IDX_89d36a68698b69fff7d3ae4f49"`);
        await queryRunner.query(`CREATE TABLE "temporary_tags" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "normalizedName" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "color" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_tags"("id", "companyId", "name", "normalizedName", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "normalizedName", "createdAt", "updatedAt" FROM "tags"`);
        await queryRunner.query(`DROP TABLE "tags"`);
        await queryRunner.query(`ALTER TABLE "temporary_tags" RENAME TO "tags"`);
        await queryRunner.query(`CREATE INDEX "IDX_40d3284c7c060f75caee62cf94" ON "tags" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_89d36a68698b69fff7d3ae4f49" ON "tags" ("companyId", "normalizedName") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_89d36a68698b69fff7d3ae4f49"`);
        await queryRunner.query(`DROP INDEX "IDX_40d3284c7c060f75caee62cf94"`);
        await queryRunner.query(`ALTER TABLE "tags" RENAME TO "temporary_tags"`);
        await queryRunner.query(`CREATE TABLE "tags" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "normalizedName" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "tags"("id", "companyId", "name", "normalizedName", "createdAt", "updatedAt") SELECT "id", "companyId", "name", "normalizedName", "createdAt", "updatedAt" FROM "temporary_tags"`);
        await queryRunner.query(`DROP TABLE "temporary_tags"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_89d36a68698b69fff7d3ae4f49" ON "tags" ("companyId", "normalizedName") `);
        await queryRunner.query(`CREATE INDEX "IDX_40d3284c7c060f75caee62cf94" ON "tags" ("companyId") `);
    }

}
