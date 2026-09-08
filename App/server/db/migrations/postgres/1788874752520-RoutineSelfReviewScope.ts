import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineSelfReviewScope1788874752520 implements MigrationInterface {
    name = 'RoutineSelfReviewScope1788874752520'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ADD "selfReviewOnly" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "revision_proposals" ADD "reviewRunId" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d02b95ff3d6b0c87d74ce85cb3" ON "revision_proposals" ("companyId", "employeeId", "reviewRunId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_d02b95ff3d6b0c87d74ce85cb3"`);
        await queryRunner.query(`ALTER TABLE "revision_proposals" DROP COLUMN "reviewRunId"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "selfReviewOnly"`);
    }

}
