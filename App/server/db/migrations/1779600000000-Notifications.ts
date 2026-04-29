import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Notifications — durable per-recipient feed for "things that need a
 * human's attention" (mentions, todos in review, pending approvals, …).
 * Replaces the on-the-fly counts that the old `/attention` endpoint
 * derived; the bell + panel in the top bar reads from this table.
 *
 * Append-only by design: we never edit `title`/`body`/`link` after
 * insert because the linked entity may have changed shape since.
 * `readAt` is the only mutated column.
 */
export class Notifications1779600000000 implements MigrationInterface {
  name = "Notifications1779600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notifications" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "userId" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "title" varchar NOT NULL,
        "body" text NOT NULL DEFAULT (''),
        "link" varchar,
        "actorKind" varchar,
        "actorId" varchar,
        "entityKind" varchar,
        "entityId" varchar,
        "readAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_userId_readAt" ON "notifications" ("userId", "readAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_userId_createdAt" ON "notifications" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_companyId_userId" ON "notifications" ("companyId", "userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_notifications_companyId_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_notifications_userId_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_notifications_userId_readAt"`,
    );
    await queryRunner.query(`DROP TABLE "notifications"`);
  }
}
