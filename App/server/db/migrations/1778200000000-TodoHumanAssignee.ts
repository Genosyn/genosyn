import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `assigneeUserId` to `todos` so work can be assigned to a human Member
 * in addition to (or instead of) an AI Employee. Only one of the two fields
 * is expected to be set at a time; the route layer enforces this.
 */
export class TodoHumanAssignee1778200000000 implements MigrationInterface {
  name = "TodoHumanAssignee1778200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "todos" ADD COLUMN "assigneeUserId" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "assigneeUserId"`);
  }
}
