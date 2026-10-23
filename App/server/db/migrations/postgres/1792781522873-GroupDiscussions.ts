import { MigrationInterface, QueryRunner } from "typeorm";

export class GroupDiscussions1792781522873 implements MigrationInterface {
    name = 'GroupDiscussions1792781522873'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "group_discussions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "channelId" character varying NOT NULL, "startedByUserId" character varying, "requesterSessionVersion" integer NOT NULL DEFAULT '0', "questionMessageId" character varying, "question" text NOT NULL DEFAULT '', "participantsJson" text NOT NULL DEFAULT '[]', "leadEmployeeId" character varying, "status" character varying NOT NULL DEFAULT 'running', "phase" character varying NOT NULL DEFAULT 'discussing', "endReason" character varying, "endDetail" character varying(500), "round" integer NOT NULL DEFAULT '0', "maxRounds" integer NOT NULL DEFAULT '3', "turnsTaken" integer NOT NULL DEFAULT '0', "maxTurns" integer NOT NULL DEFAULT '0', "tokensUsed" integer NOT NULL DEFAULT '0', "tokenBudget" integer NOT NULL DEFAULT '0', "currentEmployeeId" character varying, "stateJson" text NOT NULL DEFAULT '{}', "tainted" boolean NOT NULL DEFAULT false, "stopRequestedAt" TIMESTAMP WITH TIME ZONE, "stopRequestedByUserId" character varying, "wrapUpRequestedAt" TIMESTAMP WITH TIME ZONE, "heartbeatAt" TIMESTAMP WITH TIME ZONE, "outcomeMessageId" character varying, "outcomeJson" text, "followThroughStartedAt" TIMESTAMP WITH TIME ZONE, "followThroughByUserId" character varying, "endedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_db6bd079e9d29ff585daa3f2ea7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_76b49de66a19eeb227b696a1cc" ON "group_discussions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e386eb87ecc7b09a89a81cc0fe" ON "group_discussions" ("status", "heartbeatAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_cca7a0ce349c034176ba55a8db" ON "group_discussions" ("channelId", "createdAt") `);
        await queryRunner.query(`ALTER TABLE "channel_messages" ADD "discussionId" character varying`);
        await queryRunner.query(`ALTER TABLE "channel_messages" ADD "discussionRole" character varying`);
        await queryRunner.query(`ALTER TABLE "channel_messages" ADD "tainted" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE INDEX "IDX_bccc3fc53c4b2dc3af4b27a67e" ON "channel_messages" ("discussionId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_bccc3fc53c4b2dc3af4b27a67e"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "tainted"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "discussionRole"`);
        await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "discussionId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cca7a0ce349c034176ba55a8db"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e386eb87ecc7b09a89a81cc0fe"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_76b49de66a19eeb227b696a1cc"`);
        await queryRunner.query(`DROP TABLE "group_discussions"`);
    }

}
