import { MigrationInterface, QueryRunner } from "typeorm";

export class TldrQuestions1787332543470 implements MigrationInterface {
    name = 'TldrQuestions1787332543470'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tldr_questions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "tldrId" character varying NOT NULL, "employeeId" character varying, "prompt" text NOT NULL DEFAULT '', "promptMessageId" character varying, "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_84d868cb5a1f98d0c32e2da124d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_0e69b32d64de743d729c090706" ON "tldr_questions" ("companyId", "tldrId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "tldr_question_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "tldrId" character varying NOT NULL, "questionId" character varying NOT NULL, "role" character varying NOT NULL, "employeeId" character varying, "modelId" character varying, "content" text NOT NULL DEFAULT '', "status" character varying, "actionsJson" text NOT NULL DEFAULT '', "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ae14d5b08fc7f527aefcfc740c2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a6eb3a707489eba8ed40c8063a" ON "tldr_question_messages" ("questionId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_88a5cf5662a0333775ef80b919" ON "tldr_question_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_88a5cf5662a0333775ef80b919"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a6eb3a707489eba8ed40c8063a"`);
        await queryRunner.query(`DROP TABLE "tldr_question_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0e69b32d64de743d729c090706"`);
        await queryRunner.query(`DROP TABLE "tldr_questions"`);
    }

}
