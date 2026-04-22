import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `employee_memory_items` — per-employee durable facts injected into
 * every chat / routine prompt. Humans and the AI both contribute rows; the
 * join target is `AIEmployee.id`.
 */
export class EmployeeMemory1778100000000 implements MigrationInterface {
  name = "EmployeeMemory1778100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employee_memory_items" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "title" varchar NOT NULL,
        "body" text NOT NULL DEFAULT (''),
        "authorUserId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_memory_items_employeeId" ON "employee_memory_items" ("employeeId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_employee_memory_items_employeeId"`);
    await queryRunner.query(`DROP TABLE "employee_memory_items"`);
  }
}
