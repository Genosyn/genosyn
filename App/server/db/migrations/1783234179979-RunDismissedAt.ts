import { MigrationInterface, QueryRunner } from "typeorm";

export class RunDismissedAt1783234179979 implements MigrationInterface {
    name = 'RunDismissedAt1783234179979'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`CREATE TABLE "temporary_runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''), "dismissedAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent" FROM "runs"`);
        await queryRunner.query(`DROP TABLE "runs"`);
        await queryRunner.query(`ALTER TABLE "temporary_runs" RENAME TO "runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
        await queryRunner.query(`ALTER TABLE "runs" RENAME TO "temporary_runs"`);
        await queryRunner.query(`CREATE TABLE "runs" ("id" varchar PRIMARY KEY NOT NULL, "routineId" varchar NOT NULL, "startedAt" datetime NOT NULL, "finishedAt" datetime, "status" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "exitCode" integer, "logContent" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "runs"("id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent") SELECT "id", "routineId", "startedAt", "finishedAt", "status", "createdAt", "exitCode", "logContent" FROM "temporary_runs"`);
        await queryRunner.query(`DROP TABLE "temporary_runs"`);
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
    }

}
