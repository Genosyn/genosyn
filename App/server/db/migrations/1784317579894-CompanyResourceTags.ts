import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyResourceTags1784317579894 implements MigrationInterface {
    name = 'CompanyResourceTags1784317579894'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tags" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "normalizedName" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_89d36a68698b69fff7d3ae4f49" ON "tags" ("companyId", "normalizedName") `);
        await queryRunner.query(`CREATE INDEX "IDX_40d3284c7c060f75caee62cf94" ON "tags" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "tag_assignments" ("id" varchar PRIMARY KEY NOT NULL, "tagId" varchar NOT NULL, "resourceType" varchar NOT NULL, "resourceId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a6103b2120fe83ac66c50bbcbe" ON "tag_assignments" ("tagId", "resourceType", "resourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_aca936b80320da8de3d9374441" ON "tag_assignments" ("resourceType", "resourceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9c15a7140e7ae4975effa2b922" ON "tag_assignments" ("tagId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9c15a7140e7ae4975effa2b922"`);
        await queryRunner.query(`DROP INDEX "IDX_aca936b80320da8de3d9374441"`);
        await queryRunner.query(`DROP INDEX "IDX_a6103b2120fe83ac66c50bbcbe"`);
        await queryRunner.query(`DROP TABLE "tag_assignments"`);
        await queryRunner.query(`DROP INDEX "IDX_40d3284c7c060f75caee62cf94"`);
        await queryRunner.query(`DROP INDEX "IDX_89d36a68698b69fff7d3ae4f49"`);
        await queryRunner.query(`DROP TABLE "tags"`);
    }

}
