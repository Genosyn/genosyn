import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineAiAccess1791275691941 implements MigrationInterface {
    name = 'RoutineAiAccess1791275691941'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_routine_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('write'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dd1de6f2e340986c7d0699080f" ON "employee_routine_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_05827483caea00ecfeca8314e5" ON "employee_routine_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_05827483caea00ecfeca8314e5"`);
        await queryRunner.query(`DROP INDEX "IDX_dd1de6f2e340986c7d0699080f"`);
        await queryRunner.query(`DROP TABLE "employee_routine_grants"`);
    }

}
