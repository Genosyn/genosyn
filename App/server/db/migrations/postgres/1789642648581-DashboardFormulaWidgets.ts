import { MigrationInterface, QueryRunner } from "typeorm";

export class DashboardFormulaWidgets1789642648581 implements MigrationInterface {
    name = 'DashboardFormulaWidgets1789642648581'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dashboard_cards" ADD "formulaJson" text`);
        await queryRunner.query(`ALTER TABLE "dashboard_cards" ALTER COLUMN "chartId" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "dashboard_cards" ALTER COLUMN "chartId" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "dashboard_cards" DROP COLUMN "formulaJson"`);
    }

}
