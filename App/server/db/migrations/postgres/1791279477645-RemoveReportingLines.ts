import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveReportingLines1791279477645 implements MigrationInterface {
    name = 'RemoveReportingLines1791279477645'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_employees" DROP COLUMN "reportsToEmployeeId"`);
        await queryRunner.query(`ALTER TABLE "ai_employees" DROP COLUMN "reportsToUserId"`);
        await queryRunner.query(`ALTER TABLE "decision_policies" ALTER COLUMN "deciderKind" SET DEFAULT 'employee'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decision_policies" ALTER COLUMN "deciderKind" SET DEFAULT 'manager'`);
        await queryRunner.query(`ALTER TABLE "ai_employees" ADD "reportsToUserId" character varying`);
        await queryRunner.query(`ALTER TABLE "ai_employees" ADD "reportsToEmployeeId" character varying`);
    }

}
