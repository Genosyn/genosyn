import { MigrationInterface, QueryRunner } from "typeorm";

export class MarketingDecisionLayer1787125765683 implements MigrationInterface {
    name = 'MarketingDecisionLayer1787125765683'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "marketing_campaigns" ADD "targetDirection" character varying NOT NULL DEFAULT 'at_most'`);
        await queryRunner.query(`ALTER TABLE "marketing_performance_snapshots" ADD "supersededAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_5b209a90a5d36e764c5437bf97" ON "marketing_performance_snapshots" ("companyId", "campaignId", "periodStart", "periodEnd") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5b209a90a5d36e764c5437bf97"`);
        await queryRunner.query(`ALTER TABLE "marketing_performance_snapshots" DROP COLUMN "supersededAt"`);
        await queryRunner.query(`ALTER TABLE "marketing_campaigns" DROP COLUMN "targetDirection"`);
    }

}
