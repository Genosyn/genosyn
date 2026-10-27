import { MigrationInterface, QueryRunner } from "typeorm";

export class ChartBaseSource1793106716427 implements MigrationInterface {
    name = 'ChartBaseSource1793106716427'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "charts" ADD "baseId" character varying`);
        await queryRunner.query(`ALTER TABLE "charts" ADD "baseQueryJson" text`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`ALTER TABLE "charts" ALTER COLUMN "connectionId" DROP NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_a4b3f581766c791da14a40f8bd" ON "charts" ("companyId", "baseId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b82f0964a35cc821000fbc2975"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a4b3f581766c791da14a40f8bd"`);
        await queryRunner.query(`ALTER TABLE "charts" ALTER COLUMN "connectionId" SET NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_b82f0964a35cc821000fbc2975" ON "charts" ("companyId", "connectionId") `);
        await queryRunner.query(`ALTER TABLE "charts" DROP COLUMN "baseQueryJson"`);
        await queryRunner.query(`ALTER TABLE "charts" DROP COLUMN "baseId"`);
    }

}
