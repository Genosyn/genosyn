import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoLinks1793878441214 implements MigrationInterface {
    name = 'TodoLinks1793878441214'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "todo_links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "todoId" character varying NOT NULL, "kind" character varying NOT NULL, "targetId" character varying NOT NULL, "isSource" boolean NOT NULL DEFAULT false, "label" character varying NOT NULL DEFAULT '', "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b6db3c7e1d3397bd3ed83973eda" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1c71127864968c2d840c55c7df" ON "todo_links" ("companyId", "kind", "targetId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_39ba24b3823d7351a19811c983" ON "todo_links" ("todoId", "kind", "targetId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_39ba24b3823d7351a19811c983"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1c71127864968c2d840c55c7df"`);
        await queryRunner.query(`DROP TABLE "todo_links"`);
    }

}
