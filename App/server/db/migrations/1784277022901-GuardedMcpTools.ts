import { MigrationInterface, QueryRunner } from "typeorm";

export class GuardedMcpTools1784277022901 implements MigrationInterface {
    name = 'GuardedMcpTools1784277022901'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_4f45f9c05d800e60516016bce5"`);
        await queryRunner.query(`DROP INDEX "IDX_9a29b53912c86234e774a1240f"`);
        await queryRunner.query(`CREATE TABLE "temporary_mcp_servers" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "transport" varchar NOT NULL, "command" varchar, "argsJson" text, "envJson" text, "url" varchar, "enabled" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "guardedToolsJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_mcp_servers"("id", "employeeId", "name", "transport", "command", "argsJson", "envJson", "url", "enabled", "createdAt") SELECT "id", "employeeId", "name", "transport", "command", "argsJson", "envJson", "url", "enabled", "createdAt" FROM "mcp_servers"`);
        await queryRunner.query(`DROP TABLE "mcp_servers"`);
        await queryRunner.query(`ALTER TABLE "temporary_mcp_servers" RENAME TO "mcp_servers"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4f45f9c05d800e60516016bce5" ON "mcp_servers" ("employeeId", "name") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a29b53912c86234e774a1240f" ON "mcp_servers" ("employeeId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9a29b53912c86234e774a1240f"`);
        await queryRunner.query(`DROP INDEX "IDX_4f45f9c05d800e60516016bce5"`);
        await queryRunner.query(`ALTER TABLE "mcp_servers" RENAME TO "temporary_mcp_servers"`);
        await queryRunner.query(`CREATE TABLE "mcp_servers" ("id" varchar PRIMARY KEY NOT NULL, "employeeId" varchar NOT NULL, "name" varchar NOT NULL, "transport" varchar NOT NULL, "command" varchar, "argsJson" text, "envJson" text, "url" varchar, "enabled" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "mcp_servers"("id", "employeeId", "name", "transport", "command", "argsJson", "envJson", "url", "enabled", "createdAt") SELECT "id", "employeeId", "name", "transport", "command", "argsJson", "envJson", "url", "enabled", "createdAt" FROM "temporary_mcp_servers"`);
        await queryRunner.query(`DROP TABLE "temporary_mcp_servers"`);
        await queryRunner.query(`CREATE INDEX "IDX_9a29b53912c86234e774a1240f" ON "mcp_servers" ("employeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_4f45f9c05d800e60516016bce5" ON "mcp_servers" ("employeeId", "name") `);
    }

}
