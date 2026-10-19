import { MigrationInterface, QueryRunner } from "typeorm";

export class ResourceFolders1792402358870 implements MigrationInterface {
    name = 'ResourceFolders1792402358870'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "resource_folders" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "parentId" varchar, "sortOrder" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f5c0fcc2d231f993436c71809" ON "resource_folders" ("companyId", "parentId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_86e172f095fccfa65565147c85" ON "resource_folders" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_d8ad5844e65318a961ed6283c9" ON "resource_folders" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_6b45e2ff392972158a306f0fbc"`);
        await queryRunner.query(`DROP INDEX "IDX_7e67e70759a1a595641031a8d4"`);
        await queryRunner.query(`CREATE TABLE "temporary_resources" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "sourceKind" varchar NOT NULL DEFAULT ('url'), "sourceUrl" varchar, "sourceFilename" varchar, "storageKey" varchar, "summary" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "tags" varchar NOT NULL DEFAULT (''), "bytes" bigint NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('pending'), "errorMessage" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "folderId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_resources"("id", "companyId", "title", "slug", "sourceKind", "sourceUrl", "sourceFilename", "storageKey", "summary", "bodyText", "tags", "bytes", "status", "errorMessage", "createdById", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "sourceKind", "sourceUrl", "sourceFilename", "storageKey", "summary", "bodyText", "tags", "bytes", "status", "errorMessage", "createdById", "createdByEmployeeId", "createdAt", "updatedAt" FROM "resources"`);
        await queryRunner.query(`DROP TABLE "resources"`);
        await queryRunner.query(`ALTER TABLE "temporary_resources" RENAME TO "resources"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6b45e2ff392972158a306f0fbc" ON "resources" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_7e67e70759a1a595641031a8d4" ON "resources" ("companyId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_40a82b36260ddb7979a26c2ac5" ON "resources" ("companyId", "folderId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_40a82b36260ddb7979a26c2ac5"`);
        await queryRunner.query(`DROP INDEX "IDX_7e67e70759a1a595641031a8d4"`);
        await queryRunner.query(`DROP INDEX "IDX_6b45e2ff392972158a306f0fbc"`);
        await queryRunner.query(`ALTER TABLE "resources" RENAME TO "temporary_resources"`);
        await queryRunner.query(`CREATE TABLE "resources" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "title" varchar NOT NULL, "slug" varchar NOT NULL, "sourceKind" varchar NOT NULL DEFAULT ('url'), "sourceUrl" varchar, "sourceFilename" varchar, "storageKey" varchar, "summary" text NOT NULL DEFAULT (''), "bodyText" text NOT NULL DEFAULT (''), "tags" varchar NOT NULL DEFAULT (''), "bytes" bigint NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('pending'), "errorMessage" text NOT NULL DEFAULT (''), "createdById" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "resources"("id", "companyId", "title", "slug", "sourceKind", "sourceUrl", "sourceFilename", "storageKey", "summary", "bodyText", "tags", "bytes", "status", "errorMessage", "createdById", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "title", "slug", "sourceKind", "sourceUrl", "sourceFilename", "storageKey", "summary", "bodyText", "tags", "bytes", "status", "errorMessage", "createdById", "createdByEmployeeId", "createdAt", "updatedAt" FROM "temporary_resources"`);
        await queryRunner.query(`DROP TABLE "temporary_resources"`);
        await queryRunner.query(`CREATE INDEX "IDX_7e67e70759a1a595641031a8d4" ON "resources" ("companyId", "status") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6b45e2ff392972158a306f0fbc" ON "resources" ("companyId", "slug") `);
        await queryRunner.query(`DROP INDEX "IDX_d8ad5844e65318a961ed6283c9"`);
        await queryRunner.query(`DROP INDEX "IDX_86e172f095fccfa65565147c85"`);
        await queryRunner.query(`DROP INDEX "IDX_2f5c0fcc2d231f993436c71809"`);
        await queryRunner.query(`DROP TABLE "resource_folders"`);
    }

}
