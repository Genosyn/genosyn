import { MigrationInterface, QueryRunner } from "typeorm";

export class GroupDiscussions1792781452666 implements MigrationInterface {
    name = 'GroupDiscussions1792781452666'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "group_discussions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "channelId" varchar NOT NULL, "startedByUserId" varchar, "requesterSessionVersion" integer NOT NULL DEFAULT (0), "questionMessageId" varchar, "question" text NOT NULL DEFAULT (''), "participantsJson" text NOT NULL DEFAULT ('[]'), "leadEmployeeId" varchar, "status" varchar NOT NULL DEFAULT ('running'), "phase" varchar NOT NULL DEFAULT ('discussing'), "endReason" varchar, "endDetail" varchar(500), "round" integer NOT NULL DEFAULT (0), "maxRounds" integer NOT NULL DEFAULT (3), "turnsTaken" integer NOT NULL DEFAULT (0), "maxTurns" integer NOT NULL DEFAULT (0), "tokensUsed" integer NOT NULL DEFAULT (0), "tokenBudget" integer NOT NULL DEFAULT (0), "currentEmployeeId" varchar, "stateJson" text NOT NULL DEFAULT ('{}'), "tainted" boolean NOT NULL DEFAULT (0), "stopRequestedAt" datetime, "stopRequestedByUserId" varchar, "wrapUpRequestedAt" datetime, "heartbeatAt" datetime, "outcomeMessageId" varchar, "outcomeJson" text, "followThroughStartedAt" datetime, "followThroughByUserId" varchar, "endedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_76b49de66a19eeb227b696a1cc" ON "group_discussions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e386eb87ecc7b09a89a81cc0fe" ON "group_discussions" ("status", "heartbeatAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_cca7a0ce349c034176ba55a8db" ON "group_discussions" ("channelId", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_3d76c24eff9881b6f0ecd49f74"`);
        await queryRunner.query(`DROP INDEX "IDX_e46fa6635be01a4fba56dd98c4"`);
        await queryRunner.query(`CREATE TABLE "temporary_channel_messages" ("id" varchar PRIMARY KEY NOT NULL, "channelId" varchar NOT NULL, "authorKind" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "content" text NOT NULL DEFAULT (''), "parentMessageId" varchar, "editedAt" datetime, "deletedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "authorName" varchar, "discussionId" varchar, "discussionRole" varchar, "tainted" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_channel_messages"("id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt", "authorName") SELECT "id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt", "authorName" FROM "channel_messages"`);
        await queryRunner.query(`DROP TABLE "channel_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_channel_messages" RENAME TO "channel_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_3d76c24eff9881b6f0ecd49f74" ON "channel_messages" ("channelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e46fa6635be01a4fba56dd98c4" ON "channel_messages" ("channelId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bccc3fc53c4b2dc3af4b27a67e" ON "channel_messages" ("discussionId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_bccc3fc53c4b2dc3af4b27a67e"`);
        await queryRunner.query(`DROP INDEX "IDX_e46fa6635be01a4fba56dd98c4"`);
        await queryRunner.query(`DROP INDEX "IDX_3d76c24eff9881b6f0ecd49f74"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" RENAME TO "temporary_channel_messages"`);
        await queryRunner.query(`CREATE TABLE "channel_messages" ("id" varchar PRIMARY KEY NOT NULL, "channelId" varchar NOT NULL, "authorKind" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "content" text NOT NULL DEFAULT (''), "parentMessageId" varchar, "editedAt" datetime, "deletedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "authorName" varchar)`);
        await queryRunner.query(`INSERT INTO "channel_messages"("id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt", "authorName") SELECT "id", "channelId", "authorKind", "authorUserId", "authorEmployeeId", "content", "parentMessageId", "editedAt", "deletedAt", "createdAt", "updatedAt", "authorName" FROM "temporary_channel_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_channel_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_e46fa6635be01a4fba56dd98c4" ON "channel_messages" ("channelId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3d76c24eff9881b6f0ecd49f74" ON "channel_messages" ("channelId") `);
        await queryRunner.query(`DROP INDEX "IDX_cca7a0ce349c034176ba55a8db"`);
        await queryRunner.query(`DROP INDEX "IDX_e386eb87ecc7b09a89a81cc0fe"`);
        await queryRunner.query(`DROP INDEX "IDX_76b49de66a19eeb227b696a1cc"`);
        await queryRunner.query(`DROP TABLE "group_discussions"`);
    }

}
