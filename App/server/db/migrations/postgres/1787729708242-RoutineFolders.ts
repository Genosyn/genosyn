import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineFolders1787729708242 implements MigrationInterface {
    name = 'RoutineFolders1787729708242'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_folders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "slug" character varying NOT NULL, "parentId" character varying, "sortOrder" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8059813359fbc466ef916c90bc1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_4421f6ac97607f90afc6473f51" ON "routine_folders" ("companyId", "parentId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_db59aa7dfe2b3527fb8220437b" ON "routine_folders" ("companyId", "slug") `);
        await queryRunner.query(`CREATE INDEX "IDX_d1df6153bea86d36894c20710b" ON "routine_folders" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "routines" ADD "folderId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "folderId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d1df6153bea86d36894c20710b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_db59aa7dfe2b3527fb8220437b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4421f6ac97607f90afc6473f51"`);
        await queryRunner.query(`DROP TABLE "routine_folders"`);
    }

}
