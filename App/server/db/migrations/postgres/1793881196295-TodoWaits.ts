import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoWaits1793881196295 implements MigrationInterface {
    name = 'TodoWaits1793881196295'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "todos" ADD "waitingOn" character varying`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "waitingRefId" character varying`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "waitingReason" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "waitingSince" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "waitingCheckAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "followUpCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "todo_comments" ADD "systemNote" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE INDEX "IDX_b8cb9a07318f3ee98906a1e480" ON "todos" ("waitingOn", "waitingRefId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b8cb9a07318f3ee98906a1e480"`);
        await queryRunner.query(`ALTER TABLE "todo_comments" DROP COLUMN "systemNote"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "followUpCount"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "waitingCheckAt"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "waitingSince"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "waitingReason"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "waitingRefId"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "waitingOn"`);
    }

}
