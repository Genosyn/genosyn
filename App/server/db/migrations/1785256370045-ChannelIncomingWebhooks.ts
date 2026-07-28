import { MigrationInterface, QueryRunner } from "typeorm";

export class ChannelIncomingWebhooks1785256370045 implements MigrationInterface {
    name = 'ChannelIncomingWebhooks1785256370045'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_2d8807a303a16d39b67df2fa68"`);
        await queryRunner.query(`DROP INDEX "IDX_9b44168388cb4cc8fcfa925a1b"`);
        await queryRunner.query(`CREATE TABLE "temporary_channels" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "name" varchar, "slug" varchar, "topic" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "archivedAt" datetime, "lastMessageAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "webhookToken" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_channels"("id", "companyId", "kind", "name", "slug", "topic", "createdByUserId", "archivedAt", "lastMessageAt", "createdAt", "updatedAt") SELECT "id", "companyId", "kind", "name", "slug", "topic", "createdByUserId", "archivedAt", "lastMessageAt", "createdAt", "updatedAt" FROM "channels"`);
        await queryRunner.query(`DROP TABLE "channels"`);
        await queryRunner.query(`ALTER TABLE "temporary_channels" RENAME TO "channels"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2d8807a303a16d39b67df2fa68" ON "channels" ("companyId", "slug") WHERE "slug" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_9b44168388cb4cc8fcfa925a1b" ON "channels" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_e46fa6635be01a4fba56dd98c4"`);
        await queryRunner.query(`DROP INDEX "IDX_3d76c24eff9881b6f0ecd49f74"`);
        await queryRunner.query(`CREATE TABLE "temporary_channel_messages" ("id" varchar PRIMARY KEY NOT NULL, "channelId" varchar NOT NULL, "authorKind" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "content" text NOT NULL DEFAULT (''), "parentMessageId" varchar, "editedAt" datetime, "deletedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "authorName" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_channel_messages"("id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt") SELECT "id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt" FROM "channel_messages"`);
        await queryRunner.query(`DROP TABLE "channel_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_channel_messages" RENAME TO "channel_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_e46fa6635be01a4fba56dd98c4" ON "channel_messages" ("channelId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3d76c24eff9881b6f0ecd49f74" ON "channel_messages" ("channelId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3d76c24eff9881b6f0ecd49f74"`);
        await queryRunner.query(`DROP INDEX "IDX_e46fa6635be01a4fba56dd98c4"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" RENAME TO "temporary_channel_messages"`);
        await queryRunner.query(`CREATE TABLE "channel_messages" ("id" varchar PRIMARY KEY NOT NULL, "channelId" varchar NOT NULL, "authorKind" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "content" text NOT NULL DEFAULT (''), "parentMessageId" varchar, "editedAt" datetime, "deletedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "channel_messages"("id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt") SELECT "id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt" FROM "temporary_channel_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_channel_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_3d76c24eff9881b6f0ecd49f74" ON "channel_messages" ("channelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e46fa6635be01a4fba56dd98c4" ON "channel_messages" ("channelId", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_9b44168388cb4cc8fcfa925a1b"`);
        await queryRunner.query(`DROP INDEX "IDX_2d8807a303a16d39b67df2fa68"`);
        await queryRunner.query(`ALTER TABLE "channels" RENAME TO "temporary_channels"`);
        await queryRunner.query(`CREATE TABLE "channels" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "name" varchar, "slug" varchar, "topic" varchar NOT NULL DEFAULT (''), "createdByUserId" varchar, "archivedAt" datetime, "lastMessageAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "channels"("id", "companyId", "kind", "name", "slug", "topic", "createdByUserId", "archivedAt", "lastMessageAt", "createdAt", "updatedAt") SELECT "id", "companyId", "kind", "name", "slug", "topic", "createdByUserId", "archivedAt", "lastMessageAt", "createdAt", "updatedAt" FROM "temporary_channels"`);
        await queryRunner.query(`DROP TABLE "temporary_channels"`);
        await queryRunner.query(`CREATE INDEX "IDX_9b44168388cb4cc8fcfa925a1b" ON "channels" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2d8807a303a16d39b67df2fa68" ON "channels" ("companyId", "slug") WHERE "slug" IS NOT NULL`);
    }

}
