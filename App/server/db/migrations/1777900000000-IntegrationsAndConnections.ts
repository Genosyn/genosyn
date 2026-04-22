import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Integrations & Connections framework. Adds:
 *   - `integration_connections`: per-company authenticated accounts inside
 *     a third-party Integration (Stripe, Gmail, Metabase, …). The integration
 *     *type* is a static catalog in code; this table holds the account rows.
 *   - `employee_connection_grants`: many-to-many access grants from
 *     AIEmployee → IntegrationConnection.
 *
 * Credentials live in `encryptedConfig` (AES-256-GCM, keyed off
 * sessionSecret — same scheme as `secrets` and AIModel apikey configs).
 */
export class IntegrationsAndConnections1777900000000 implements MigrationInterface {
  name = "IntegrationsAndConnections1777900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "integration_connections" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "provider" varchar NOT NULL,
        "label" varchar NOT NULL,
        "authMode" varchar NOT NULL DEFAULT ('apikey'),
        "encryptedConfig" text NOT NULL,
        "accountHint" varchar NOT NULL DEFAULT (''),
        "status" varchar NOT NULL DEFAULT ('connected'),
        "statusMessage" varchar NOT NULL DEFAULT (''),
        "lastCheckedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_integration_connections_companyId" ON "integration_connections" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_integration_connections_company_provider" ON "integration_connections" ("companyId", "provider")`,
    );

    await queryRunner.query(
      `CREATE TABLE "employee_connection_grants" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "connectionId" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_connection_grants_employeeId" ON "employee_connection_grants" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_connection_grants_connectionId" ON "employee_connection_grants" ("connectionId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_employee_connection_grants_pair" ON "employee_connection_grants" ("employeeId", "connectionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_employee_connection_grants_pair"`);
    await queryRunner.query(`DROP INDEX "IDX_employee_connection_grants_connectionId"`);
    await queryRunner.query(`DROP INDEX "IDX_employee_connection_grants_employeeId"`);
    await queryRunner.query(`DROP TABLE "employee_connection_grants"`);
    await queryRunner.query(`DROP INDEX "IDX_integration_connections_company_provider"`);
    await queryRunner.query(`DROP INDEX "IDX_integration_connections_companyId"`);
    await queryRunner.query(`DROP TABLE "integration_connections"`);
  }
}
