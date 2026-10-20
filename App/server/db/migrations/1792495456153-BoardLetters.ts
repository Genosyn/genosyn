import { MigrationInterface, QueryRunner } from "typeorm";

export class BoardLetters1792495456153 implements MigrationInterface {
    name = 'BoardLetters1792495456153'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "board_letters" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "number" integer NOT NULL, "month" varchar NOT NULL, "periodStart" datetime NOT NULL, "periodEnd" datetime NOT NULL, "timeZone" varchar NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('writing'), "triggerKind" varchar NOT NULL DEFAULT ('schedule'), "attempts" integer NOT NULL DEFAULT (0), "retryAt" datetime, "startedAt" datetime NOT NULL, "writtenAt" datetime, "deliveredAt" datetime, "writerEmployeeId" varchar, "writerName" varchar NOT NULL DEFAULT (''), "writerRole" varchar NOT NULL DEFAULT (''), "writerSlug" varchar NOT NULL DEFAULT (''), "writerAvatarKey" varchar, "auditStatus" varchar NOT NULL DEFAULT ('pending'), "auditorEmployeeId" varchar, "auditorName" varchar NOT NULL DEFAULT (''), "auditorRole" varchar NOT NULL DEFAULT (''), "auditorSlug" varchar NOT NULL DEFAULT (''), "auditorAvatarKey" varchar, "auditedAt" datetime, "untracedCount" integer NOT NULL DEFAULT (0), "summary" text NOT NULL DEFAULT (''), "errorMessage" text NOT NULL DEFAULT (''), "auditNote" text NOT NULL DEFAULT (''), "auditFindingsJson" text NOT NULL DEFAULT ('[]'), "traceJson" text NOT NULL DEFAULT ('{}'), "figuresJson" text NOT NULL DEFAULT ('{}'), "evidenceJson" text NOT NULL DEFAULT ('{}'), "body" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_7294fcda87213081762fea099f" ON "board_letters" ("status", "startedAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a6f6ee6a245251850244551a32" ON "board_letters" ("companyId", "number") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_2a27b5b5298dbbe67d5d520efb" ON "board_letters" ("companyId", "month") `);
        await queryRunner.query(`CREATE TABLE "board_letter_settings" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "enabledAt" datetime, "writerEmployeeId" varchar, "auditorEmployeeId" varchar, "auditorAppointedByUserId" varchar, "auditorAppointedAt" datetime, "nextLetterAt" datetime, "lastError" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_d165883e1c457919aab0c53704" ON "board_letter_settings" ("enabled", "nextLetterAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fc57a9bdf1bd7c82138a53bbea" ON "board_letter_settings" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_fc57a9bdf1bd7c82138a53bbea"`);
        await queryRunner.query(`DROP INDEX "IDX_d165883e1c457919aab0c53704"`);
        await queryRunner.query(`DROP TABLE "board_letter_settings"`);
        await queryRunner.query(`DROP INDEX "IDX_2a27b5b5298dbbe67d5d520efb"`);
        await queryRunner.query(`DROP INDEX "IDX_a6f6ee6a245251850244551a32"`);
        await queryRunner.query(`DROP INDEX "IDX_7294fcda87213081762fea099f"`);
        await queryRunner.query(`DROP TABLE "board_letters"`);
    }

}
