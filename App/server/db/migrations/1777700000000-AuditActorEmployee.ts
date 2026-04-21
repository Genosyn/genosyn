import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Give `audit_events` a way to name the AI employee that performed an action
 * via the built-in Genosyn MCP server. `actorKind` is a free-form varchar so
 * the new `"ai"` value needs no schema change; we only add the id column.
 */
export class AuditActorEmployee1777700000000 implements MigrationInterface {
  name = "AuditActorEmployee1777700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_events" ADD COLUMN "actorEmployeeId" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite before 3.35 couldn't DROP COLUMN; better-sqlite3 ships a modern
    // build so this works. On Postgres it's a plain ALTER.
    await queryRunner.query(
      `ALTER TABLE "audit_events" DROP COLUMN "actorEmployeeId"`,
    );
  }
}
