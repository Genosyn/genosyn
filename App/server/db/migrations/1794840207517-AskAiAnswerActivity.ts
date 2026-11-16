import { MigrationInterface, QueryRunner } from "typeorm";

export class AskAiAnswerActivity1794840207517 implements MigrationInterface {
    name = 'AskAiAnswerActivity1794840207517'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a99b101fdce69f9b3662157c0a"`);
        await queryRunner.query(`DROP INDEX "IDX_9b3932bc2e254621833d7d8bd5"`);
        await queryRunner.query(`DROP INDEX "IDX_47dd568f8d75f87adbbd4285e2"`);
        await queryRunner.query(`CREATE TABLE "temporary_ask_ai_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "turnId" varchar, "employeeId" varchar, "modelId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "suggestionsJson" text NOT NULL DEFAULT (''), "contextJson" text NOT NULL DEFAULT (''), "contextKind" varchar, "contextId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL, "activityJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_ask_ai_messages"("id", "companyId", "conversationId", "role", "turnId", "employeeId", "modelId", "content", "status", "actionsJson", "suggestionsJson", "contextJson", "contextKind", "contextId", "createdByUserId", "createdAt") SELECT "id", "companyId", "conversationId", "role", "turnId", "employeeId", "modelId", "content", "status", "actionsJson", "suggestionsJson", "contextJson", "contextKind", "contextId", "createdByUserId", "createdAt" FROM "ask_ai_messages"`);
        await queryRunner.query(`DROP TABLE "ask_ai_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_ask_ai_messages" RENAME TO "ask_ai_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_a99b101fdce69f9b3662157c0a" ON "ask_ai_messages" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b3932bc2e254621833d7d8bd5" ON "ask_ai_messages" ("conversationId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_47dd568f8d75f87adbbd4285e2" ON "ask_ai_messages" ("contextKind", "contextId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_47dd568f8d75f87adbbd4285e2"`);
        await queryRunner.query(`DROP INDEX "IDX_9b3932bc2e254621833d7d8bd5"`);
        await queryRunner.query(`DROP INDEX "IDX_a99b101fdce69f9b3662157c0a"`);
        await queryRunner.query(`ALTER TABLE "ask_ai_messages" RENAME TO "temporary_ask_ai_messages"`);
        await queryRunner.query(`CREATE TABLE "ask_ai_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "conversationId" varchar NOT NULL, "role" varchar NOT NULL, "turnId" varchar, "employeeId" varchar, "modelId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "suggestionsJson" text NOT NULL DEFAULT (''), "contextJson" text NOT NULL DEFAULT (''), "contextKind" varchar, "contextId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL)`);
        await queryRunner.query(`INSERT INTO "ask_ai_messages"("id", "companyId", "conversationId", "role", "turnId", "employeeId", "modelId", "content", "status", "actionsJson", "suggestionsJson", "contextJson", "contextKind", "contextId", "createdByUserId", "createdAt") SELECT "id", "companyId", "conversationId", "role", "turnId", "employeeId", "modelId", "content", "status", "actionsJson", "suggestionsJson", "contextJson", "contextKind", "contextId", "createdByUserId", "createdAt" FROM "temporary_ask_ai_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_ask_ai_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_47dd568f8d75f87adbbd4285e2" ON "ask_ai_messages" ("contextKind", "contextId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b3932bc2e254621833d7d8bd5" ON "ask_ai_messages" ("conversationId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a99b101fdce69f9b3662157c0a" ON "ask_ai_messages" ("companyId") `);
    }

}
