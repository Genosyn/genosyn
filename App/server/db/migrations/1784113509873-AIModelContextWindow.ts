import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Add `ai_models.contextWindow` — the model's token ceiling as reported by the
 * provider, or NULL when it doesn't say (see services/agent/contextWindow.ts).
 *
 * Hand-written rather than generated: `migration:generate` wants to rebuild the
 * whole table to also reset `authMode`'s stored default from the pre-direct-API
 * value, which is unrelated drift and does not belong in this migration. A
 * plain ADD COLUMN is portable across the sqlite and postgres drivers.
 */
export class AIModelContextWindow1784113509873 implements MigrationInterface {
  name = "AIModelContextWindow1784113509873";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "contextWindow" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "contextWindow"`);
  }
}
