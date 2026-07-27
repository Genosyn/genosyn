import { MigrationInterface, QueryRunner } from "typeorm";

export class RevenueFollowUpViews1785176533979 implements MigrationInterface {
    name = 'RevenueFollowUpViews1785176533979'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "revenue_follow_up_views" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "name" varchar NOT NULL, "filtersJson" text NOT NULL DEFAULT ('{}'), "sortOrder" float NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_2ab00547091e8dcdd00b20395b" ON "revenue_follow_up_views" ("companyId", "sortOrder", "name") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_2ab00547091e8dcdd00b20395b"`);
        await queryRunner.query(`DROP TABLE "revenue_follow_up_views"`);
    }

}
