import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Incoming webhooks as routine triggers. Each routine can expose an
 * unauthenticated URL that external systems POST to; the token in the
 * URL is the shared secret. Regenerate by toggling off/on.
 */
export class RoutineWebhooks1776900000000 implements MigrationInterface {
  name = "RoutineWebhooks1776900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "routines" ADD COLUMN "webhookEnabled" boolean NOT NULL DEFAULT (0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "routines" ADD COLUMN "webhookToken" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "webhookToken"`);
    await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "webhookEnabled"`);
  }
}
