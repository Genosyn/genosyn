import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * EmployeeNotebookGrant — gives an AI employee read or write access to a
 * whole Notebook. Access cascades from the notebook grant onto every
 * Note inside (and every sub-page below those notes), resolved at request
 * time so revocation behaves like Notion's share model — change one
 * notebook share and every page below follows.
 */
export class NotebookGrants1779800000000 implements MigrationInterface {
  name = "NotebookGrants1779800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employee_notebook_grants" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "notebookId" varchar NOT NULL,
        "accessLevel" varchar NOT NULL DEFAULT ('write'),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_notebook_grants_employeeId" ON "employee_notebook_grants" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_notebook_grants_notebookId" ON "employee_notebook_grants" ("notebookId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_employee_notebook_grants_employee_notebook" ON "employee_notebook_grants" ("employeeId", "notebookId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_employee_notebook_grants_employee_notebook"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_employee_notebook_grants_notebookId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_employee_notebook_grants_employeeId"`,
    );
    await queryRunner.query(`DROP TABLE "employee_notebook_grants"`);
  }
}
