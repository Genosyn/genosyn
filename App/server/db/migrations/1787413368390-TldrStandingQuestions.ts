import { MigrationInterface, QueryRunner } from "typeorm";

export class TldrStandingQuestions1787413368390 implements MigrationInterface {
    name = 'TldrStandingQuestions1787413368390'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tldr_question_actions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "questionId" varchar NOT NULL, "messageId" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('other'), "label" varchar NOT NULL DEFAULT (''), "intent" text NOT NULL DEFAULT (''), "position" integer NOT NULL DEFAULT (0), "status" varchar NOT NULL DEFAULT ('proposed'), "runMessageId" varchar, "completedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_419afa1942034c266f9a77e3d0" ON "tldr_question_actions" ("questionId", "position") `);
        await queryRunner.query(`CREATE INDEX "IDX_68410b416b1fb82eb2a115dc57" ON "tldr_question_actions" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "tldr_standing_questions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "prompt" text NOT NULL DEFAULT (''), "enabled" boolean NOT NULL DEFAULT (1), "position" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_1779d9ed1c482d2968953775fe" ON "tldr_standing_questions" ("companyId", "position") `);
        await queryRunner.query(`DROP INDEX "IDX_e3307821b3acc9331199d8cef7"`);
        await queryRunner.query(`DROP INDEX "IDX_3cfd2f67b3de018b2602fc3d5a"`);
        await queryRunner.query(`CREATE TABLE "temporary_tldrs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar, "employeeName" varchar NOT NULL, "employeeSlug" varchar NOT NULL, "employeeRole" varchar NOT NULL, "employeeAvatarKey" varchar, "status" varchar NOT NULL DEFAULT ('generating'), "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "periodStart" datetime NOT NULL, "periodEnd" datetime NOT NULL, "title" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "body" text NOT NULL DEFAULT (''), "sourceStatsJson" text NOT NULL DEFAULT ('{}'), "errorMessage" text NOT NULL DEFAULT (''), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "standingAnsweredAt" datetime)`);
        await queryRunner.query(`INSERT INTO "temporary_tldrs"("id", "companyId", "employeeId", "employeeName", "employeeSlug", "employeeRole", "employeeAvatarKey", "status", "triggerKind", "periodStart", "periodEnd", "title", "summary", "body", "sourceStatsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "employeeId", "employeeName", "employeeSlug", "employeeRole", "employeeAvatarKey", "status", "triggerKind", "periodStart", "periodEnd", "title", "summary", "body", "sourceStatsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt" FROM "tldrs"`);
        await queryRunner.query(`DROP TABLE "tldrs"`);
        await queryRunner.query(`ALTER TABLE "temporary_tldrs" RENAME TO "tldrs"`);
        await queryRunner.query(`CREATE INDEX "IDX_e3307821b3acc9331199d8cef7" ON "tldrs" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3cfd2f67b3de018b2602fc3d5a" ON "tldrs" ("companyId", "periodStart", "periodEnd") `);
        await queryRunner.query(`DROP INDEX "IDX_0e69b32d64de743d729c090706"`);
        await queryRunner.query(`CREATE TABLE "temporary_tldr_questions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "employeeId" varchar, "prompt" text NOT NULL DEFAULT (''), "promptMessageId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "origin" varchar NOT NULL DEFAULT ('member'), "standingQuestionId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_tldr_questions"("id", "companyId", "tldrId", "employeeId", "prompt", "promptMessageId", "createdByUserId", "createdAt", "updatedAt") SELECT "id", "companyId", "tldrId", "employeeId", "prompt", "promptMessageId", "createdByUserId", "createdAt", "updatedAt" FROM "tldr_questions"`);
        await queryRunner.query(`DROP TABLE "tldr_questions"`);
        await queryRunner.query(`ALTER TABLE "temporary_tldr_questions" RENAME TO "tldr_questions"`);
        await queryRunner.query(`CREATE INDEX "IDX_0e69b32d64de743d729c090706" ON "tldr_questions" ("companyId", "tldrId", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_88a5cf5662a0333775ef80b919"`);
        await queryRunner.query(`DROP INDEX "IDX_a6eb3a707489eba8ed40c8063a"`);
        await queryRunner.query(`CREATE TABLE "temporary_tldr_question_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "questionId" varchar NOT NULL, "role" varchar NOT NULL, "employeeId" varchar, "modelId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "actionId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_tldr_question_messages"("id", "companyId", "tldrId", "questionId", "role", "employeeId", "modelId", "content", "status", "actionsJson", "createdByUserId", "createdAt") SELECT "id", "companyId", "tldrId", "questionId", "role", "employeeId", "modelId", "content", "status", "actionsJson", "createdByUserId", "createdAt" FROM "tldr_question_messages"`);
        await queryRunner.query(`DROP TABLE "tldr_question_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_tldr_question_messages" RENAME TO "tldr_question_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_88a5cf5662a0333775ef80b919" ON "tldr_question_messages" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_a6eb3a707489eba8ed40c8063a" ON "tldr_question_messages" ("questionId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_a6eb3a707489eba8ed40c8063a"`);
        await queryRunner.query(`DROP INDEX "IDX_88a5cf5662a0333775ef80b919"`);
        await queryRunner.query(`ALTER TABLE "tldr_question_messages" RENAME TO "temporary_tldr_question_messages"`);
        await queryRunner.query(`CREATE TABLE "tldr_question_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "questionId" varchar NOT NULL, "role" varchar NOT NULL, "employeeId" varchar, "modelId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "tldr_question_messages"("id", "companyId", "tldrId", "questionId", "role", "employeeId", "modelId", "content", "status", "actionsJson", "createdByUserId", "createdAt") SELECT "id", "companyId", "tldrId", "questionId", "role", "employeeId", "modelId", "content", "status", "actionsJson", "createdByUserId", "createdAt" FROM "temporary_tldr_question_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_tldr_question_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_a6eb3a707489eba8ed40c8063a" ON "tldr_question_messages" ("questionId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_88a5cf5662a0333775ef80b919" ON "tldr_question_messages" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_0e69b32d64de743d729c090706"`);
        await queryRunner.query(`ALTER TABLE "tldr_questions" RENAME TO "temporary_tldr_questions"`);
        await queryRunner.query(`CREATE TABLE "tldr_questions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "employeeId" varchar, "prompt" text NOT NULL DEFAULT (''), "promptMessageId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "tldr_questions"("id", "companyId", "tldrId", "employeeId", "prompt", "promptMessageId", "createdByUserId", "createdAt", "updatedAt") SELECT "id", "companyId", "tldrId", "employeeId", "prompt", "promptMessageId", "createdByUserId", "createdAt", "updatedAt" FROM "temporary_tldr_questions"`);
        await queryRunner.query(`DROP TABLE "temporary_tldr_questions"`);
        await queryRunner.query(`CREATE INDEX "IDX_0e69b32d64de743d729c090706" ON "tldr_questions" ("companyId", "tldrId", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_3cfd2f67b3de018b2602fc3d5a"`);
        await queryRunner.query(`DROP INDEX "IDX_e3307821b3acc9331199d8cef7"`);
        await queryRunner.query(`ALTER TABLE "tldrs" RENAME TO "temporary_tldrs"`);
        await queryRunner.query(`CREATE TABLE "tldrs" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar, "employeeName" varchar NOT NULL, "employeeSlug" varchar NOT NULL, "employeeRole" varchar NOT NULL, "employeeAvatarKey" varchar, "status" varchar NOT NULL DEFAULT ('generating'), "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "periodStart" datetime NOT NULL, "periodEnd" datetime NOT NULL, "title" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "body" text NOT NULL DEFAULT (''), "sourceStatsJson" text NOT NULL DEFAULT ('{}'), "errorMessage" text NOT NULL DEFAULT (''), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "tldrs"("id", "companyId", "employeeId", "employeeName", "employeeSlug", "employeeRole", "employeeAvatarKey", "status", "triggerKind", "periodStart", "periodEnd", "title", "summary", "body", "sourceStatsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt") SELECT "id", "companyId", "employeeId", "employeeName", "employeeSlug", "employeeRole", "employeeAvatarKey", "status", "triggerKind", "periodStart", "periodEnd", "title", "summary", "body", "sourceStatsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt" FROM "temporary_tldrs"`);
        await queryRunner.query(`DROP TABLE "temporary_tldrs"`);
        await queryRunner.query(`CREATE INDEX "IDX_3cfd2f67b3de018b2602fc3d5a" ON "tldrs" ("companyId", "periodStart", "periodEnd") `);
        await queryRunner.query(`CREATE INDEX "IDX_e3307821b3acc9331199d8cef7" ON "tldrs" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`DROP INDEX "IDX_1779d9ed1c482d2968953775fe"`);
        await queryRunner.query(`DROP TABLE "tldr_standing_questions"`);
        await queryRunner.query(`DROP INDEX "IDX_68410b416b1fb82eb2a115dc57"`);
        await queryRunner.query(`DROP INDEX "IDX_419afa1942034c266f9a77e3d0"`);
        await queryRunner.query(`DROP TABLE "tldr_question_actions"`);
    }

}
