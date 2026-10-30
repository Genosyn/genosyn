import { MigrationInterface, QueryRunner } from "typeorm";

export class WorkspaceChannelTurns1793396367875 implements MigrationInterface {
    name = 'WorkspaceChannelTurns1793396367875'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "channel_turns" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "channelId" varchar NOT NULL, "employeeId" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('reply'), "triggerMessageId" varchar, "discussionId" varchar, "round" integer, "authority" varchar NOT NULL DEFAULT ('untrusted'), "requesterUserId" varchar, "requesterSessionVersion" integer, "status" varchar NOT NULL DEFAULT ('working'), "waitingFor" varchar, "resumeAs" varchar, "workerId" varchar, "leaseExpiresAt" datetime, "attempt" integer NOT NULL DEFAULT (0), "acceptedAt" datetime NOT NULL, "deadlineAt" datetime, "endedAt" datetime, "stoppedByUserId" varchar, "replyMessageId" varchar, "tainted" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "replyText" text NOT NULL DEFAULT (''), "activityJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f645dbbbb23604e8f1cba2272" ON "channel_turns" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_60560d506d835c91bc5e86273b" ON "channel_turns" ("discussionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1aa68244b3fe87569e9fa201a9" ON "channel_turns" ("triggerMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_739835d8cb4532cb79aae6884e" ON "channel_turns" ("replyMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_385e451a715f9569c842b3a86c" ON "channel_turns" ("status", "leaseExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_446a9407d68f3356267d0b3c0e" ON "channel_turns" ("channelId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_446a9407d68f3356267d0b3c0e"`);
        await queryRunner.query(`DROP INDEX "IDX_385e451a715f9569c842b3a86c"`);
        await queryRunner.query(`DROP INDEX "IDX_739835d8cb4532cb79aae6884e"`);
        await queryRunner.query(`DROP INDEX "IDX_1aa68244b3fe87569e9fa201a9"`);
        await queryRunner.query(`DROP INDEX "IDX_60560d506d835c91bc5e86273b"`);
        await queryRunner.query(`DROP INDEX "IDX_2f645dbbbb23604e8f1cba2272"`);
        await queryRunner.query(`DROP TABLE "channel_turns"`);
    }

}
