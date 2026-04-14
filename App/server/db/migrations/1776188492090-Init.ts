import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1776188492090 implements MigrationInterface {
    name = 'Init1776188492090'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "passwordHash" varchar NOT NULL, "name" varchar NOT NULL, "resetToken" varchar, "resetExpiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"))`);
        await queryRunner.query(`CREATE TABLE "companies" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "ownerId" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_b28b07d25e4324eee577de5496d" UNIQUE ("slug"))`);
        await queryRunner.query(`CREATE TABLE "memberships" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "userId" varchar NOT NULL, "role" varchar NOT NULL)`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3a1cdbb1434a2c0a6f3f95a860" ON "memberships" ("companyId", "userId") `);
        await queryRunner.query(`CREATE TABLE "invitations" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "email" varchar NOT NULL, "token" varchar NOT NULL, "expiresAt" datetime NOT NULL, "acceptedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_e577dcf9bb6d084373ed3998509" UNIQUE ("token"))`);
        await queryRunner.query(`CREATE TABLE "ai_models" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "provider" varchar NOT NULL, "model" varchar NOT NULL, "configJson" text NOT NULL DEFAULT ('{}'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE TABLE "ai_employees" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "role" varchar NOT NULL, "defaultModelId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8cf7de39f600c1d51250df21" ON "ai_employees" ("companyId", "slug") `);
        await queryRunner.query(`CREATE TABLE "skills" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5b93a7f44ad4d2d2267ff5be01" ON "skills" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE TABLE "routines" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "slug" varchar NOT NULL, "cronExpr" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "lastRunAt" datetime, "modelId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59e11503010aeeab1de06f89a9" ON "routines" ("employeeId", "slug") `);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "logsPath" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`DROP INDEX "IDX_59e11503010aeeab1de06f89a9"`);
        await queryRunner.query(`DROP TABLE "routines"`);
        await queryRunner.query(`DROP INDEX "IDX_5b93a7f44ad4d2d2267ff5be01"`);
        await queryRunner.query(`DROP TABLE "skills"`);
        await queryRunner.query(`DROP INDEX "IDX_ee8cf7de39f600c1d51250df21"`);
        await queryRunner.query(`DROP TABLE "ai_employees"`);
        await queryRunner.query(`DROP TABLE "ai_models"`);
        await queryRunner.query(`DROP TABLE "invitations"`);
        await queryRunner.query(`DROP INDEX "IDX_3a1cdbb1434a2c0a6f3f95a860"`);
        await queryRunner.query(`DROP TABLE "memberships"`);
        await queryRunner.query(`DROP TABLE "companies"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
