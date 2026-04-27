import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Folds the standalone `gmail` integration into the umbrella `google`
 * provider. After this migration, one Connection row carries the user's
 * Google account credentials and exposes Gmail + Drive (+ future Workspace
 * services) as a unified tool set, instead of forcing a separate consent +
 * row for each Google product.
 *
 * Existing Gmail rows already hold an OAuth refresh token whose granted
 * scope is `gmail.modify` — they keep working, but Drive tools will throw
 * an "out-of-scope" error until the user re-clicks Connect on the
 * Connection (Google's `include_granted_scopes` adds drive.readonly to the
 * same grant in place).
 */
export class RenameGmailProviderToGoogle1778900000000
  implements MigrationInterface
{
  name = "RenameGmailProviderToGoogle1778900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "integration_connections" SET "provider" = 'google' WHERE "provider" = 'gmail'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "integration_connections" SET "provider" = 'gmail' WHERE "provider" = 'google'`,
    );
  }
}
