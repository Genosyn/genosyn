import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-company secrets vault. Values are encrypted with the same
 * sessionSecret-derived key as stored model API keys, and never leave the
 * server unmasked. On spawn, the runner merges them into the child env.
 */
export class Secrets1777100000000 implements MigrationInterface {
  name = "Secrets1777100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "secrets" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "encryptedValue" varchar NOT NULL,
        "description" varchar NOT NULL DEFAULT (''),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_secrets_companyId" ON "secrets" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_secrets_company_name" ON "secrets" ("companyId", "name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_secrets_company_name"`);
    await queryRunner.query(`DROP INDEX "IDX_secrets_companyId"`);
    await queryRunner.query(`DROP TABLE "secrets"`);
  }
}
