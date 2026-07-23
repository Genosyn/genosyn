import { MigrationInterface, QueryRunner } from "typeorm";

export class SkillToolset1784825744991 implements MigrationInterface {
    name = 'SkillToolset1784825744991'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5b93a7f44ad4d2d2267ff5be01"`);
        await queryRunner.query(`CREATE TABLE "temporary_skills" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "body" text NOT NULL DEFAULT (''), "toolsetJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_skills"("id", "employeeId", "name", "slug", "createdAt", "body") SELECT "id", "employeeId", "name", "slug", "createdAt", "body" FROM "skills"`);
        await queryRunner.query(`DROP TABLE "skills"`);
        await queryRunner.query(`ALTER TABLE "temporary_skills" RENAME TO "skills"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5b93a7f44ad4d2d2267ff5be01" ON "skills" ("employeeId", "slug") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_5b93a7f44ad4d2d2267ff5be01"`);
        await queryRunner.query(`ALTER TABLE "skills" RENAME TO "temporary_skills"`);
        await queryRunner.query(`CREATE TABLE "skills" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "body" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "skills"("id", "employeeId", "name", "slug", "createdAt", "body") SELECT "id", "employeeId", "name", "slug", "createdAt", "body" FROM "temporary_skills"`);
        await queryRunner.query(`DROP TABLE "temporary_skills"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5b93a7f44ad4d2d2267ff5be01" ON "skills" ("employeeId", "slug") `);
    }

}
