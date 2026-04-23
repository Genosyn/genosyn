import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates the Slack-style workspace-chat surface: channels (public /
 * private / dm), channel members (user or AI employee), channel messages
 * with soft-delete and threading support, emoji reactions, and attachments.
 *
 * These are distinct from the per-employee 1:1 chat entities
 * (`conversations` / `conversation_messages`). That surface stays as-is; the
 * new one is for group chat, DMs, file sharing, and multi-employee
 * collaboration. See ROADMAP §M9.
 */
export class WorkspaceChannels1778600000000 implements MigrationInterface {
  name = "WorkspaceChannels1778600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "channels" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "name" varchar,
        "slug" varchar,
        "topic" varchar NOT NULL DEFAULT (''),
        "createdByUserId" varchar,
        "archivedAt" datetime,
        "lastMessageAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channels_companyId" ON "channels" ("companyId")`,
    );
    // Partial unique index so DMs (slug IS NULL) don't collide.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_channels_companyId_slug" ON "channels" ("companyId", "slug") WHERE "slug" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "channel_members" (
        "id" varchar PRIMARY KEY NOT NULL,
        "channelId" varchar NOT NULL,
        "memberKind" varchar NOT NULL,
        "userId" varchar,
        "employeeId" varchar,
        "lastReadAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_members_channelId" ON "channel_members" ("channelId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_members_userId" ON "channel_members" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_members_employeeId" ON "channel_members" ("employeeId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_channel_members_channel_user" ON "channel_members" ("channelId", "userId") WHERE "userId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_channel_members_channel_emp" ON "channel_members" ("channelId", "employeeId") WHERE "employeeId" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "channel_messages" (
        "id" varchar PRIMARY KEY NOT NULL,
        "channelId" varchar NOT NULL,
        "authorKind" varchar NOT NULL,
        "authorUserId" varchar,
        "authorEmployeeId" varchar,
        "content" text NOT NULL DEFAULT (''),
        "parentMessageId" varchar,
        "editedAt" datetime,
        "deletedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_messages_channelId" ON "channel_messages" ("channelId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_messages_channel_createdAt" ON "channel_messages" ("channelId", "createdAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "message_reactions" (
        "id" varchar PRIMARY KEY NOT NULL,
        "messageId" varchar NOT NULL,
        "emoji" varchar NOT NULL,
        "userId" varchar,
        "employeeId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_reactions_messageId" ON "message_reactions" ("messageId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_message_reactions_msg_emoji_user" ON "message_reactions" ("messageId", "emoji", "userId") WHERE "userId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_message_reactions_msg_emoji_emp" ON "message_reactions" ("messageId", "emoji", "employeeId") WHERE "employeeId" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "attachments" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "messageId" varchar,
        "filename" varchar NOT NULL,
        "mimeType" varchar NOT NULL DEFAULT ('application/octet-stream'),
        "sizeBytes" bigint NOT NULL DEFAULT (0),
        "storageKey" varchar NOT NULL,
        "uploadedByUserId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_attachments_messageId" ON "attachments" ("messageId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_attachments_messageId"`);
    await queryRunner.query(`DROP TABLE "attachments"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_message_reactions_msg_emoji_emp"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_message_reactions_msg_emoji_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_message_reactions_messageId"`,
    );
    await queryRunner.query(`DROP TABLE "message_reactions"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_channel_messages_channel_createdAt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_channel_messages_channelId"`,
    );
    await queryRunner.query(`DROP TABLE "channel_messages"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_channel_members_channel_emp"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_channel_members_channel_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_channel_members_employeeId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_channel_members_userId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_channel_members_channelId"`,
    );
    await queryRunner.query(`DROP TABLE "channel_members"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_channels_companyId_slug"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_channels_companyId"`);
    await queryRunner.query(`DROP TABLE "channels"`);
  }
}
