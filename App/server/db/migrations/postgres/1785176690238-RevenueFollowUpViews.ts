import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueFollowUpViews1785176690238 implements MigrationInterface {
    name = 'RevenueFollowUpViews1785176690238'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "revenue_follow_up_views" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "name" character varying NOT NULL, "filtersJson" text NOT NULL DEFAULT '{}', "sortOrder" double precision NOT NULL DEFAULT '0', "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ea176708750e04635c8859c2047" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2ab00547091e8dcdd00b20395b" ON "revenue_follow_up_views" ("companyId", "sortOrder", "name") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_2ab00547091e8dcdd00b20395b"`);
        await queryRunner.query(`DROP TABLE "revenue_follow_up_views"`);
    }

}
