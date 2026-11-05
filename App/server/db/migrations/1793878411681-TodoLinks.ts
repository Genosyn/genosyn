import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoLinks1793878411681 implements MigrationInterface {
    name = 'TodoLinks1793878411681'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "todo_links" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "todoId" varchar NOT NULL, "kind" varchar NOT NULL, "targetId" varchar NOT NULL, "isSource" boolean NOT NULL DEFAULT (0), "label" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_1c71127864968c2d840c55c7df" ON "todo_links" ("companyId", "kind", "targetId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_39ba24b3823d7351a19811c983" ON "todo_links" ("todoId", "kind", "targetId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_39ba24b3823d7351a19811c983"`);
        await queryRunner.query(`DROP INDEX "IDX_1c71127864968c2d840c55c7df"`);
        await queryRunner.query(`DROP TABLE "todo_links"`);
    }

}
