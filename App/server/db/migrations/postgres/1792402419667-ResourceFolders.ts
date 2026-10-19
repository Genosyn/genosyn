import { MigrationInterface, QueryRunner } from "typeorm";

export class ResourceFolders1792402419667 implements MigrationInterface {
    name = 'ResourceFolders1792402419667'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "resource_folders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "parentId" character varying, "sortOrder" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f0f83a38af11935cbfb3a7e3aa2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f5c0fcc2d231f993436c71809" ON "resource_folders" ("companyId", "parentId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_86e172f095fccfa65565147c85" ON "resource_folders" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_d8ad5844e65318a961ed6283c9" ON "resource_folders" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "resources" ADD "folderId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_40a82b36260ddb7979a26c2ac5" ON "resources" ("companyId", "folderId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_40a82b36260ddb7979a26c2ac5"`);
        await queryRunner.query(`ALTER TABLE "resources" DROP COLUMN "folderId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d8ad5844e65318a961ed6283c9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_86e172f095fccfa65565147c85"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2f5c0fcc2d231f993436c71809"`);
        await queryRunner.query(`DROP TABLE "resource_folders"`);
    }

}
