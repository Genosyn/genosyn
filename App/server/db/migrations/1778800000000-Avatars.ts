import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds profile/avatar image support to humans and AI employees. Images are
 * stored on disk under `data/avatars/` and referenced by their basename so a
 * company/employee slug rename doesn't orphan them.
 */
export class Avatars1778800000000 implements MigrationInterface {
  name = "Avatars1778800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "avatarKey" varchar`);
    await queryRunner.query(
      `ALTER TABLE "ai_employees" ADD COLUMN "avatarKey" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_employees" DROP COLUMN "avatarKey"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "avatarKey"`);
  }
}
