import { MigrationInterface, QueryRunner } from "typeorm";

export class PhoneNumbers1791901152807 implements MigrationInterface {
    name = 'PhoneNumbers1791901152807'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "phone_numbers" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "connectionId" varchar NOT NULL, "employeeId" varchar, "e164" varchar NOT NULL, "providerSid" varchar NOT NULL, "label" varchar NOT NULL DEFAULT (''), "country" varchar NOT NULL DEFAULT (''), "locality" varchar NOT NULL DEFAULT (''), "voiceEnabled" boolean NOT NULL DEFAULT (1), "smsEnabled" boolean NOT NULL DEFAULT (1), "mmsEnabled" boolean NOT NULL DEFAULT (0), "callMode" varchar NOT NULL DEFAULT ('answer'), "forwardTo" varchar, "textMode" varchar NOT NULL DEFAULT ('inbox'), "greeting" text NOT NULL DEFAULT (''), "instructions" text NOT NULL DEFAULT (''), "voice" varchar NOT NULL DEFAULT ('Polly.Joanna-Neural'), "dailyTextLimit" integer NOT NULL DEFAULT (50), "dailyCallLimit" integer NOT NULL DEFAULT (10), "webhookBaseUrl" varchar, "webhookError" varchar NOT NULL DEFAULT (''), "reservedInGenosyn" boolean NOT NULL DEFAULT (1), "lastTextSyncAt" datetime, "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e5808ebf94e6660390de3954e1" ON "phone_numbers" ("providerSid") `);
        await queryRunner.query(`CREATE INDEX "IDX_984aaf5aabf5b7b9671c278f66" ON "phone_numbers" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f2c8b8c63eb16750bc90ce4451" ON "phone_numbers" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_44549ba65946e6e0cc4f950d90" ON "phone_numbers" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "phone_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "phoneNumberId" varchar NOT NULL, "employeeId" varchar, "direction" varchar NOT NULL, "fromNumber" varchar NOT NULL, "toNumber" varchar NOT NULL, "providerSid" varchar, "status" varchar NOT NULL, "occurredAt" datetime NOT NULL, "errorCode" integer, "errorMessage" varchar NOT NULL DEFAULT (''), "sentByUserId" varchar, "runId" varchar, "autoReply" boolean NOT NULL DEFAULT (0), "mediaJson" text NOT NULL DEFAULT (''), "body" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_96eaf4a9fc6dab048fe46b14e7" ON "phone_messages" ("providerSid") WHERE "providerSid" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_c5e46605b6c675aaef3de35674" ON "phone_messages" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_05ef91cbb7472194fbdc42b560" ON "phone_messages" ("phoneNumberId", "occurredAt") `);
        await queryRunner.query(`CREATE TABLE "phone_calls" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "phoneNumberId" varchar NOT NULL, "employeeId" varchar, "direction" varchar NOT NULL, "fromNumber" varchar NOT NULL, "toNumber" varchar NOT NULL, "providerSid" varchar, "status" varchar NOT NULL DEFAULT ('queued'), "handling" varchar NOT NULL DEFAULT ('employee'), "answeredAt" datetime, "endedAt" datetime, "durationSec" integer, "endReason" varchar NOT NULL DEFAULT (''), "errorMessage" varchar NOT NULL DEFAULT (''), "runId" varchar, "placedByUserId" varchar, "turnCount" integer NOT NULL DEFAULT (0), "silenceCount" integer NOT NULL DEFAULT (0), "replyState" varchar NOT NULL DEFAULT ('idle'), "replyTurnId" varchar, "replyStartedAt" datetime, "replyEndsCall" boolean NOT NULL DEFAULT (0), "replyDigits" varchar NOT NULL DEFAULT (''), "replyText" text NOT NULL DEFAULT (''), "brief" text NOT NULL DEFAULT (''), "openingLine" text NOT NULL DEFAULT (''), "transcriptJson" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1d49ab79c740cb47a9f481d7d9" ON "phone_calls" ("providerSid") WHERE "providerSid" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_06096dce29776d63381e0c60f7" ON "phone_calls" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b7d0dc283b5e5984e84a3c638" ON "phone_calls" ("phoneNumberId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_9b7d0dc283b5e5984e84a3c638"`);
        await queryRunner.query(`DROP INDEX "IDX_06096dce29776d63381e0c60f7"`);
        await queryRunner.query(`DROP INDEX "IDX_1d49ab79c740cb47a9f481d7d9"`);
        await queryRunner.query(`DROP TABLE "phone_calls"`);
        await queryRunner.query(`DROP INDEX "IDX_05ef91cbb7472194fbdc42b560"`);
        await queryRunner.query(`DROP INDEX "IDX_c5e46605b6c675aaef3de35674"`);
        await queryRunner.query(`DROP INDEX "IDX_96eaf4a9fc6dab048fe46b14e7"`);
        await queryRunner.query(`DROP TABLE "phone_messages"`);
        await queryRunner.query(`DROP INDEX "IDX_44549ba65946e6e0cc4f950d90"`);
        await queryRunner.query(`DROP INDEX "IDX_f2c8b8c63eb16750bc90ce4451"`);
        await queryRunner.query(`DROP INDEX "IDX_984aaf5aabf5b7b9671c278f66"`);
        await queryRunner.query(`DROP INDEX "IDX_e5808ebf94e6660390de3954e1"`);
        await queryRunner.query(`DROP TABLE "phone_numbers"`);
    }

}
