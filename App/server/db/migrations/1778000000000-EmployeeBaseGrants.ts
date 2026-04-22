import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the `employee_base_grants` join table — per-employee access grants to
 * Bases, mirroring the shape of `employee_connection_grants`.
 */
export class EmployeeBaseGrants1778000000000 implements MigrationInterface {
  name = "EmployeeBaseGrants1778000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employee_base_grants" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "baseId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_base_grants_employeeId" ON "employee_base_grants" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_base_grants_baseId" ON "employee_base_grants" ("baseId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_employee_base_grants_pair" ON "employee_base_grants" ("employeeId", "baseId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_employee_base_grants_pair"`);
    await queryRunner.query(`DROP INDEX "IDX_employee_base_grants_baseId"`);
    await queryRunner.query(`DROP INDEX "IDX_employee_base_grants_employeeId"`);
    await queryRunner.query(`DROP TABLE "employee_base_grants"`);
  }
}
