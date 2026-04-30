import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Programmatic API keys. See entities/ApiKey.ts for the design rationale —
 * sha256 over a 32-byte random secret, one-time plaintext display, soft
 * revocation, company-scoped (a key authenticates as its owning user but
 * only unlocks one company).
 */
export class ApiKeys1780200000000 implements MigrationInterface {
  name = "ApiKeys1780200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "api_keys" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "prefix" varchar(16) NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "lastUsedAt" datetime,
        "expiresAt" datetime,
        "revokedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_companyId" ON "api_keys" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_userId" ON "api_keys" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_prefix" ON "api_keys" ("prefix")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_api_keys_tokenHash" ON "api_keys" ("tokenHash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_api_keys_tokenHash"`);
    await queryRunner.query(`DROP INDEX "IDX_api_keys_prefix"`);
    await queryRunner.query(`DROP INDEX "IDX_api_keys_userId"`);
    await queryRunner.query(`DROP INDEX "IDX_api_keys_companyId"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
  }
}
