import { MigrationInterface, QueryRunner } from "typeorm";

export class AskAi1791218006914 implements MigrationInterface {
    name = 'AskAi1791218006914'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ask_ai_conversations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "ownerUserId" character varying NOT NULL, "title" character varying, "lastMessageAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0bd1a3739877fc55f803569bbe4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a203529b939196e8dcf221cb76" ON "ask_ai_conversations" ("companyId", "ownerUserId", "lastMessageAt") `);
        await queryRunner.query(`CREATE TABLE "ask_ai_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "conversationId" character varying NOT NULL, "role" character varying NOT NULL, "turnId" character varying, "employeeId" character varying, "modelId" character varying, "content" text NOT NULL DEFAULT '', "status" character varying, "actionsJson" text NOT NULL DEFAULT '', "suggestionsJson" text NOT NULL DEFAULT '', "contextJson" text NOT NULL DEFAULT '', "contextKind" character varying, "contextId" character varying, "createdByUserId" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_04192b12b3444861e37c239be79" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_47dd568f8d75f87adbbd4285e2" ON "ask_ai_messages" ("contextKind", "contextId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b3932bc2e254621833d7d8bd5" ON "ask_ai_messages" ("conversationId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a99b101fdce69f9b3662157c0a" ON "ask_ai_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a99b101fdce69f9b3662157c0a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9b3932bc2e254621833d7d8bd5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_47dd568f8d75f87adbbd4285e2"`);
        await queryRunner.query(`DROP TABLE "ask_ai_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a203529b939196e8dcf221cb76"`);
        await queryRunner.query(`DROP TABLE "ask_ai_conversations"`);
    }

}
