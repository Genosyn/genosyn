import { MigrationInterface, QueryRunner } from "typeorm";

export class WorkspaceChannelTurns1793396481621 implements MigrationInterface {
    name = 'WorkspaceChannelTurns1793396481621'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "channel_turns" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "channelId" character varying NOT NULL, "employeeId" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'reply', "triggerMessageId" character varying, "discussionId" character varying, "round" integer, "authority" character varying NOT NULL DEFAULT 'untrusted', "requesterUserId" character varying, "requesterSessionVersion" integer, "status" character varying NOT NULL DEFAULT 'working', "waitingFor" character varying, "resumeAs" character varying, "workerId" character varying, "leaseExpiresAt" TIMESTAMP WITH TIME ZONE, "attempt" integer NOT NULL DEFAULT '0', "acceptedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "deadlineAt" TIMESTAMP WITH TIME ZONE, "endedAt" TIMESTAMP WITH TIME ZONE, "stoppedByUserId" character varying, "replyMessageId" character varying, "tainted" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "replyText" text NOT NULL DEFAULT '', "activityJson" text NOT NULL DEFAULT '', CONSTRAINT "PK_27784754a643efa31a974b9eb05" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2f645dbbbb23604e8f1cba2272" ON "channel_turns" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_60560d506d835c91bc5e86273b" ON "channel_turns" ("discussionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1aa68244b3fe87569e9fa201a9" ON "channel_turns" ("triggerMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_739835d8cb4532cb79aae6884e" ON "channel_turns" ("replyMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_385e451a715f9569c842b3a86c" ON "channel_turns" ("status", "leaseExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_446a9407d68f3356267d0b3c0e" ON "channel_turns" ("channelId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_446a9407d68f3356267d0b3c0e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_385e451a715f9569c842b3a86c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_739835d8cb4532cb79aae6884e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1aa68244b3fe87569e9fa201a9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_60560d506d835c91bc5e86273b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2f645dbbbb23604e8f1cba2272"`);
        await queryRunner.query(`DROP TABLE "channel_turns"`);
    }

}
