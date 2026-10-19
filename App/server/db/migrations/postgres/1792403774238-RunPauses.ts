import { MigrationInterface, QueryRunner } from "typeorm";

export class RunPauses1792403774238 implements MigrationInterface {
    name = 'RunPauses1792403774238'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" ADD "pausedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "pauseCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "pauseRemainingMs" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "pauseRemainingMs"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "pauseCount"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "pausedAt"`);
    }

}
