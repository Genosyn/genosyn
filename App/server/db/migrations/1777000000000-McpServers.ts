import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-employee MCP server configs. Materialized to `.mcp.json` in the
 * employee's workspace before each provider CLI spawn so tools show up
 * natively to the model.
 */
export class McpServers1777000000000 implements MigrationInterface {
  name = "McpServers1777000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "mcp_servers" (
        "id" varchar PRIMARY KEY NOT NULL,
        "employeeId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "transport" varchar NOT NULL,
        "command" varchar,
        "argsJson" text,
        "envJson" text,
        "url" varchar,
        "enabled" boolean NOT NULL DEFAULT (1),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mcp_servers_employeeId" ON "mcp_servers" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_mcp_servers_employee_name" ON "mcp_servers" ("employeeId", "name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_mcp_servers_employee_name"`);
    await queryRunner.query(`DROP INDEX "IDX_mcp_servers_employeeId"`);
    await queryRunner.query(`DROP TABLE "mcp_servers"`);
  }
}
