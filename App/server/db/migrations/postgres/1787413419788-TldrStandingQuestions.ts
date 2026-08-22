import { MigrationInterface, QueryRunner } from "typeorm";

export class TldrStandingQuestions1787413419788 implements MigrationInterface {
    name = 'TldrStandingQuestions1787413419788'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "tldr_question_actions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "tldrId" character varying NOT NULL, "questionId" character varying NOT NULL, "messageId" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'other', "label" character varying NOT NULL DEFAULT '', "intent" text NOT NULL DEFAULT '', "position" integer NOT NULL DEFAULT '0', "status" character varying NOT NULL DEFAULT 'proposed', "runMessageId" character varying, "completedByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8ec68bdb316de89a0e597ad9129" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_419afa1942034c266f9a77e3d0" ON "tldr_question_actions" ("questionId", "position") `);
        await queryRunner.query(`CREATE INDEX "IDX_68410b416b1fb82eb2a115dc57" ON "tldr_question_actions" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "tldr_standing_questions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "prompt" text NOT NULL DEFAULT '', "enabled" boolean NOT NULL DEFAULT true, "position" integer NOT NULL DEFAULT '0', "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_032a950f23ad3014fb5218fde98" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1779d9ed1c482d2968953775fe" ON "tldr_standing_questions" ("companyId", "position") `);
        await queryRunner.query(`ALTER TABLE "tldrs" ADD "standingAnsweredAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "tldr_questions" ADD "origin" character varying NOT NULL DEFAULT 'member'`);
        await queryRunner.query(`ALTER TABLE "tldr_questions" ADD "standingQuestionId" character varying`);
        await queryRunner.query(`ALTER TABLE "tldr_question_messages" ADD "actionId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tldr_question_messages" DROP COLUMN "actionId"`);
        await queryRunner.query(`ALTER TABLE "tldr_questions" DROP COLUMN "standingQuestionId"`);
        await queryRunner.query(`ALTER TABLE "tldr_questions" DROP COLUMN "origin"`);
        await queryRunner.query(`ALTER TABLE "tldrs" DROP COLUMN "standingAnsweredAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1779d9ed1c482d2968953775fe"`);
        await queryRunner.query(`DROP TABLE "tldr_standing_questions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_68410b416b1fb82eb2a115dc57"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_419afa1942034c266f9a77e3d0"`);
        await queryRunner.query(`DROP TABLE "tldr_question_actions"`);
    }

}
