import { MigrationInterface, QueryRunner } from "typeorm";

export class RunContinuations1789979222616 implements MigrationInterface {
    name = 'RunContinuations1789979222616'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" ADD "checkpointJson" text`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "continuationCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "continuationOriginTriggerKind" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "continuationReviewOnly" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "continuationDeadlineAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "continuationTokensUsed" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "continuationStopReason" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "continuationStopReason"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "continuationTokensUsed"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "continuationDeadlineAt"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "continuationReviewOnly"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "continuationOriginTriggerKind"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "continuationCount"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "checkpointJson"`);
    }

}
