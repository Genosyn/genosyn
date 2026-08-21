import { MigrationInterface, QueryRunner } from "typeorm";

export class TldrQuestions1787332531115 implements MigrationInterface {
    name = 'TldrQuestions1787332531115'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tldr_questions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "employeeId" varchar, "prompt" text NOT NULL DEFAULT (''), "promptMessageId" varchar, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_0e69b32d64de743d729c090706" ON "tldr_questions" ("companyId", "tldrId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "tldr_question_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "tldrId" varchar NOT NULL, "questionId" varchar NOT NULL, "role" varchar NOT NULL, "employeeId" varchar, "modelId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_a6eb3a707489eba8ed40c8063a" ON "tldr_question_messages" ("questionId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_88a5cf5662a0333775ef80b919" ON "tldr_question_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_88a5cf5662a0333775ef80b919"`);
        await queryRunner.query(`DROP INDEX "IDX_a6eb3a707489eba8ed40c8063a"`);
        await queryRunner.query(`DROP TABLE "tldr_question_messages"`);
        await queryRunner.query(`DROP INDEX "IDX_0e69b32d64de743d729c090706"`);
        await queryRunner.query(`DROP TABLE "tldr_questions"`);
    }

}
