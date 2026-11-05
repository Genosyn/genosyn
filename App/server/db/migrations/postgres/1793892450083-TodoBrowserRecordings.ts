import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoBrowserRecordings1793892450083 implements MigrationInterface {
    name = 'TodoBrowserRecordings1793892450083'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "browser_sessions" ADD "todoId" character varying`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" ADD "todoPickupId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_dc5d169985eab001cd8890a9fe" ON "browser_sessions" ("todoId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_dc5d169985eab001cd8890a9fe"`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" DROP COLUMN "todoPickupId"`);
        await queryRunner.query(`ALTER TABLE "browser_sessions" DROP COLUMN "todoId"`);
    }

}
