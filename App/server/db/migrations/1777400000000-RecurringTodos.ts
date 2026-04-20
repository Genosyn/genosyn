import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds recurrence to todos: when a recurring todo is completed, the server
 * spawns a fresh todo with the same metadata and a shifted due date.
 */
export class RecurringTodos1777400000000 implements MigrationInterface {
  name = "RecurringTodos1777400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "todos" ADD COLUMN "recurrence" varchar NOT NULL DEFAULT ('none')`,
    );
    await queryRunner.query(
      `ALTER TABLE "todos" ADD COLUMN "recurrenceParentId" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "recurrenceParentId"`);
    await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "recurrence"`);
  }
}
