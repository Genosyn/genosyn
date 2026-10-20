import { MigrationInterface, QueryRunner } from "typeorm";

export class BoardLetters1792495512976 implements MigrationInterface {
    name = 'BoardLetters1792495512976'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "board_letters" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "number" integer NOT NULL, "month" character varying NOT NULL, "periodStart" TIMESTAMP WITH TIME ZONE NOT NULL, "periodEnd" TIMESTAMP WITH TIME ZONE NOT NULL, "timeZone" character varying NOT NULL DEFAULT '', "status" character varying NOT NULL DEFAULT 'writing', "triggerKind" character varying NOT NULL DEFAULT 'schedule', "attempts" integer NOT NULL DEFAULT '0', "retryAt" TIMESTAMP WITH TIME ZONE, "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "writtenAt" TIMESTAMP WITH TIME ZONE, "deliveredAt" TIMESTAMP WITH TIME ZONE, "writerEmployeeId" character varying, "writerName" character varying NOT NULL DEFAULT '', "writerRole" character varying NOT NULL DEFAULT '', "writerSlug" character varying NOT NULL DEFAULT '', "writerAvatarKey" character varying, "auditStatus" character varying NOT NULL DEFAULT 'pending', "auditorEmployeeId" character varying, "auditorName" character varying NOT NULL DEFAULT '', "auditorRole" character varying NOT NULL DEFAULT '', "auditorSlug" character varying NOT NULL DEFAULT '', "auditorAvatarKey" character varying, "auditedAt" TIMESTAMP WITH TIME ZONE, "untracedCount" integer NOT NULL DEFAULT '0', "summary" text NOT NULL DEFAULT '', "errorMessage" text NOT NULL DEFAULT '', "auditNote" text NOT NULL DEFAULT '', "auditFindingsJson" text NOT NULL DEFAULT '[]', "traceJson" text NOT NULL DEFAULT '{}', "figuresJson" text NOT NULL DEFAULT '{}', "evidenceJson" text NOT NULL DEFAULT '{}', "body" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c6fff6612c27bbca2c9a3946f19" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_7294fcda87213081762fea099f" ON "board_letters" ("status", "startedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a6f6ee6a245251850244551a32" ON "board_letters" ("companyId", "number") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2a27b5b5298dbbe67d5d520efb" ON "board_letters" ("companyId", "month") `);
        await queryRunner.query(`CREATE TABLE "board_letter_settings" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "enabledAt" TIMESTAMP WITH TIME ZONE, "writerEmployeeId" character varying, "auditorEmployeeId" character varying, "auditorAppointedByUserId" character varying, "auditorAppointedAt" TIMESTAMP WITH TIME ZONE, "nextLetterAt" TIMESTAMP WITH TIME ZONE, "lastError" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d3bac9c4f9593c4f3e58280e6e8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d165883e1c457919aab0c53704" ON "board_letter_settings" ("enabled", "nextLetterAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fc57a9bdf1bd7c82138a53bbea" ON "board_letter_settings" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_fc57a9bdf1bd7c82138a53bbea"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d165883e1c457919aab0c53704"`);
        await queryRunner.query(`DROP TABLE "board_letter_settings"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2a27b5b5298dbbe67d5d520efb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a6f6ee6a245251850244551a32"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7294fcda87213081762fea099f"`);
        await queryRunner.query(`DROP TABLE "board_letters"`);
    }

}
