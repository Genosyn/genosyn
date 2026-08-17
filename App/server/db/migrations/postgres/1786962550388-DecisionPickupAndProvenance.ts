import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionPickupAndProvenance1786962550388 implements MigrationInterface {
    name = 'DecisionPickupAndProvenance1786962550388'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" ADD "mailThreadId" character varying`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "pickupStatus" character varying NOT NULL DEFAULT 'none'`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "pickupSummary" text`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "pickupStartedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "decisions" ADD "pickupFinishedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "pickupFinishedAt"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "pickupStartedAt"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "pickupSummary"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "pickupStatus"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "mailThreadId"`);
    }

}
