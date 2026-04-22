import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds reviewer columns to `todos` so a todo can have a designated reviewer
 * (AI Employee or human Member) distinct from the assignee. When the assignee
 * moves the todo to `in_review`, the reviewer is the one expected to sign it
 * off — they can either push it back to the assignee or mark it done. Only
 * one of the two columns is expected to be set at a time; the route layer
 * enforces this, same pattern as assignee.
 */
export class TodoReviewer1778300000000 implements MigrationInterface {
  name = "TodoReviewer1778300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "todos" ADD COLUMN "reviewerEmployeeId" varchar`);
    await queryRunner.query(`ALTER TABLE "todos" ADD COLUMN "reviewerUserId" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "reviewerUserId"`);
    await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "reviewerEmployeeId"`);
  }
}
