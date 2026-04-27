import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * EmployeeNoteGrant — gives an AI employee read or write access to a Note.
 * Access cascades down the note tree implicitly (a grant on a parent
 * authorizes every descendant), resolved at request time so reparenting
 * and revocation behave like Notion's share model.
 */
export class NoteGrants1779300000000 implements MigrationInterface {
  name = "NoteGrants1779300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employee_note_grants" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "noteId" varchar NOT NULL,
        "accessLevel" varchar NOT NULL DEFAULT ('write'),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_note_grants_employeeId" ON "employee_note_grants" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_note_grants_noteId" ON "employee_note_grants" ("noteId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_employee_note_grants_employee_note" ON "employee_note_grants" ("employeeId", "noteId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_employee_note_grants_employee_note"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_employee_note_grants_noteId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_employee_note_grants_employeeId"`);
    await queryRunner.query(`DROP TABLE "employee_note_grants"`);
  }
}
