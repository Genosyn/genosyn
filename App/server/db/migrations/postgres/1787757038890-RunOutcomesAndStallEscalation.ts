import { MigrationInterface, QueryRunner } from "typeorm";

export class RunOutcomesAndStallEscalation1787757038890 implements MigrationInterface {
    name = 'RunOutcomesAndStallEscalation1787757038890'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ADD "acceptanceCriteria" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "outcomeVerdict" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "outcomeNote" text`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "tokensIn" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "tokensOut" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "aiReviewPasses" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "approvals" ADD "stallRemindedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "stallRemindedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "handoffs" ADD "stallRemindedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "ai_employees" ALTER COLUMN "browserApprovalRequired" SET DEFAULT true`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_employees" ALTER COLUMN "browserApprovalRequired" SET DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "handoffs" DROP COLUMN "stallRemindedAt"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "stallRemindedAt"`);
        await queryRunner.query(`ALTER TABLE "approvals" DROP COLUMN "stallRemindedAt"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "aiReviewPasses"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "tokensOut"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "tokensIn"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "outcomeNote"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "outcomeVerdict"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "acceptanceCriteria"`);
    }

}
