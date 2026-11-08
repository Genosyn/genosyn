import { MigrationInterface, QueryRunner } from "typeorm";

export class DashboardLinks1794141977679 implements MigrationInterface {
    name = 'DashboardLinks1794141977679'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dashboards" ADD "linkTokenHash" character varying`);
        await queryRunner.query(`ALTER TABLE "dashboards" ADD "linkTokenEncrypted" text`);
        await queryRunner.query(`ALTER TABLE "dashboards" ADD "linkEnabledAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "dashboards" ADD "linkEnabledById" character varying`);
        await queryRunner.query(`ALTER TABLE "dashboards" ADD "linkRefreshSeconds" integer NOT NULL DEFAULT '300'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b58272ad2514dc1f7753a24f20" ON "dashboards" ("linkTokenHash") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b58272ad2514dc1f7753a24f20"`);
        await queryRunner.query(`ALTER TABLE "dashboards" DROP COLUMN "linkRefreshSeconds"`);
        await queryRunner.query(`ALTER TABLE "dashboards" DROP COLUMN "linkEnabledById"`);
        await queryRunner.query(`ALTER TABLE "dashboards" DROP COLUMN "linkEnabledAt"`);
        await queryRunner.query(`ALTER TABLE "dashboards" DROP COLUMN "linkTokenEncrypted"`);
        await queryRunner.query(`ALTER TABLE "dashboards" DROP COLUMN "linkTokenHash"`);
    }

}
