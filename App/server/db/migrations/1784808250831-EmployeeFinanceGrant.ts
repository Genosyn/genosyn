import { MigrationInterface, QueryRunner } from "typeorm";

export class EmployeeFinanceGrant1784808250831 implements MigrationInterface {
    name = 'EmployeeFinanceGrant1784808250831'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_finance_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('read'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1f8bfe17fff40760b450f3be01" ON "employee_finance_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_94ac76ea9914f1a032fa4ef8c8" ON "employee_finance_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_94ac76ea9914f1a032fa4ef8c8"`);
        await queryRunner.query(`DROP INDEX "IDX_1f8bfe17fff40760b450f3be01"`);
        await queryRunner.query(`DROP TABLE "employee_finance_grants"`);
    }

}
