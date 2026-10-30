import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatTurnActivity1793365019739 implements MigrationInterface {
    name = 'ChatTurnActivity1793365019739'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "conversation_activity_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "conversationId" character varying NOT NULL, "messageId" character varying NOT NULL, "ordinal" integer NOT NULL, "attempt" integer NOT NULL DEFAULT '1', "kind" character varying NOT NULL, "name" character varying NOT NULL DEFAULT '', "callId" character varying NOT NULL DEFAULT '', "summary" text NOT NULL DEFAULT '', "detailJson" text NOT NULL DEFAULT '', "isError" boolean NOT NULL DEFAULT false, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_263ec3d1c9fc994573b368e572d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_e09a9380db738e053393936ce2" ON "conversation_activity_events" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d3e4c1731f35fc1d6307cf4b55" ON "conversation_activity_events" ("conversationId") `);
        await queryRunner.query(`CREATE INDEX "IDX_28ec905d51dcc7ffbfa62a9bf0" ON "conversation_activity_events" ("messageId", "ordinal") `);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "activityJson" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "activityJson"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_28ec905d51dcc7ffbfa62a9bf0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d3e4c1731f35fc1d6307cf4b55"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e09a9380db738e053393936ce2"`);
        await queryRunner.query(`DROP TABLE "conversation_activity_events"`);
    }

}
