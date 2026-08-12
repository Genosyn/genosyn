import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanyMissionAndVision1786522980033 implements MigrationInterface {
    name = 'CompanyMissionAndVision1786522980033'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "temporary_companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "requireTwoFactor" boolean NOT NULL DEFAULT (0), "mission" text NOT NULL DEFAULT (''), "vision" text NOT NULL DEFAULT (''), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "temporary_companies"("id", "name", "slug", "ownerId", "createdAt", "requireTwoFactor") SELECT "id", "name", "slug", "ownerId", "createdAt", "requireTwoFactor" FROM "companies"`);
        await queryRunner.query(`DROP TABLE "companies"`);
        await queryRunner.query(`ALTER TABLE "temporary_companies" RENAME TO "companies"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "companies" RENAME TO "temporary_companies"`);
        await queryRunner.query(`CREATE TABLE "companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "requireTwoFactor" boolean NOT NULL DEFAULT (0), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`INSERT INTO "companies"("id", "name", "slug", "ownerId", "createdAt", "requireTwoFactor") SELECT "id", "name", "slug", "ownerId", "createdAt", "requireTwoFactor" FROM "temporary_companies"`);
        await queryRunner.query(`DROP TABLE "temporary_companies"`);
    }

}
