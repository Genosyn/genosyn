import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Move existing `ai_models` rows off the CLI-harness vocabulary and onto the
 * direct model-API vocabulary:
 *   provider: claude-code|codex|opencode|goose|openclaw → anthropic|openai|custom
 *   authMode: subscription|apikey|customEndpoint         → apikey|customEndpoint
 *
 * This is a DATA-ONLY migration. `provider` and `authMode` are plain varchars
 * with no CHECK constraint, so there is no schema diff for `migration:generate`
 * to emit — it is hand-authored on purpose, and only rewrites row values.
 */
export class ModelProvidersDirectApi1783234200000 implements MigrationInterface {
  name = "ModelProvidersDirectApi1783234200000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) customEndpoint rows now run through the 'custom' OpenAI-compatible
    //    provider, regardless of which router (opencode/goose) carried them.
    await queryRunner.query(
      `UPDATE "ai_models" SET "provider" = 'custom' WHERE "authMode" = 'customEndpoint'`,
    );
    // 2) The Claude-backed CLIs collapse onto the Anthropic Messages API;
    //    codex onto the OpenAI API. (Non-customEndpoint rows only.)
    await queryRunner.query(
      `UPDATE "ai_models" SET "provider" = 'anthropic' WHERE "authMode" <> 'customEndpoint' AND "provider" IN ('claude-code','opencode','goose','openclaw')`,
    );
    await queryRunner.query(
      `UPDATE "ai_models" SET "provider" = 'openai' WHERE "authMode" <> 'customEndpoint' AND "provider" = 'codex'`,
    );
    // 3) Subscription (OAuth) auth is gone — direct API access is key-based.
    //    Flip those rows to apikey and clear connectedAt so the operator is
    //    prompted to paste a key (the old on-disk OAuth creds are unusable).
    await queryRunner.query(
      `UPDATE "ai_models" SET "authMode" = 'apikey', "connectedAt" = NULL WHERE "authMode" = 'subscription'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible data migration: the original provider/auth vocabulary can't
    // be reconstructed from the remapped values. No-op so reverting a later
    // migration doesn't fail here.
  }
}
