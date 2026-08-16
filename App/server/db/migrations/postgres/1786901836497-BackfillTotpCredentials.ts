import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Moves the single authenticator seed that used to live on `users` onto its
 * own `totp_credentials` row, so the sibling migration can drop
 * `users."totpSecret"` / `users."totpEnabledAt"` without logging anyone out of
 * their second factor. The ciphertext is copied verbatim — it is still scoped
 * to the same user, so it decrypts unchanged.
 *
 * Only enrolled seeds carry over. A seed with no `totpEnabledAt` was a setup
 * someone abandoned mid-flow and never proved a code against; it is not a
 * second factor and is dropped with the columns.
 *
 * Hand-rolled because there's no schema diff for migration:generate to notice.
 */
export class BackfillTotpCredentials1786901836497 implements MigrationInterface {
  name = "BackfillTotpCredentials1786901836497";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "totp_credentials" ("userId", "name", "secret", "verifiedAt", "lastUsedAt", "createdAt")
       SELECT "id", 'Authenticator app', "totpSecret", "totpEnabledAt", NULL, "totpEnabledAt"
       FROM "users"
       WHERE "totpSecret" IS NOT NULL AND "totpEnabledAt" IS NOT NULL`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally irreversible. Once this has run, a backfilled row is
    // indistinguishable from one a Member enrolled afterwards, so deleting
    // "the migrated ones" would take real authenticators with it. Rolling
    // back the schema restores the columns empty; roll forward instead.
  }
}
