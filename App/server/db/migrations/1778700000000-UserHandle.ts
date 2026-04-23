import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `handle` to `users` so humans can claim a short @-mention identifier
 * (e.g. `@jami`) for workspace chat and any future mention surface. Unique
 * when set; users without a handle simply aren't mentionable by one yet.
 */
export class UserHandle1778700000000 implements MigrationInterface {
  name = "UserHandle1778700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "handle" varchar`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_handle" ON "users" ("handle") WHERE "handle" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_handle"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "handle"`);
  }
}
