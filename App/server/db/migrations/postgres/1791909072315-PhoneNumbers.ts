import { MigrationInterface, QueryRunner } from "typeorm";

export class PhoneNumbers1791909072315 implements MigrationInterface {
    name = 'PhoneNumbers1791909072315'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "phone_numbers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "connectionId" character varying NOT NULL, "employeeId" character varying, "e164" character varying NOT NULL, "providerSid" character varying NOT NULL, "label" character varying NOT NULL DEFAULT '', "country" character varying NOT NULL DEFAULT '', "locality" character varying NOT NULL DEFAULT '', "voiceEnabled" boolean NOT NULL DEFAULT true, "smsEnabled" boolean NOT NULL DEFAULT true, "mmsEnabled" boolean NOT NULL DEFAULT false, "callMode" character varying NOT NULL DEFAULT 'answer', "forwardTo" character varying, "textMode" character varying NOT NULL DEFAULT 'inbox', "greeting" text NOT NULL DEFAULT '', "instructions" text NOT NULL DEFAULT '', "voice" character varying NOT NULL DEFAULT 'Polly.Joanna-Neural', "dailyTextLimit" integer NOT NULL DEFAULT '50', "dailyCallLimit" integer NOT NULL DEFAULT '10', "webhookBaseUrl" character varying, "webhookError" character varying NOT NULL DEFAULT '', "reservedInGenosyn" boolean NOT NULL DEFAULT true, "lastTextSyncAt" TIMESTAMP WITH TIME ZONE, "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a72cf9a1834a1417e195fdd2c02" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_e5808ebf94e6660390de3954e1" ON "phone_numbers" ("providerSid") `);
        await queryRunner.query(`CREATE INDEX "IDX_984aaf5aabf5b7b9671c278f66" ON "phone_numbers" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f2c8b8c63eb16750bc90ce4451" ON "phone_numbers" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_44549ba65946e6e0cc4f950d90" ON "phone_numbers" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "phone_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "phoneNumberId" character varying NOT NULL, "employeeId" character varying, "direction" character varying NOT NULL, "fromNumber" character varying NOT NULL, "toNumber" character varying NOT NULL, "providerSid" character varying, "status" character varying NOT NULL, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "errorCode" integer, "errorMessage" character varying NOT NULL DEFAULT '', "sentByUserId" character varying, "runId" character varying, "autoReply" boolean NOT NULL DEFAULT false, "mediaJson" text NOT NULL DEFAULT '', "body" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_80c749280f97c121f315843122b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_96eaf4a9fc6dab048fe46b14e7" ON "phone_messages" ("providerSid") WHERE "providerSid" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_c5e46605b6c675aaef3de35674" ON "phone_messages" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_05ef91cbb7472194fbdc42b560" ON "phone_messages" ("phoneNumberId", "occurredAt") `);
        await queryRunner.query(`CREATE TABLE "phone_calls" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "phoneNumberId" character varying NOT NULL, "employeeId" character varying, "direction" character varying NOT NULL, "fromNumber" character varying NOT NULL, "toNumber" character varying NOT NULL, "providerSid" character varying, "status" character varying NOT NULL DEFAULT 'queued', "handling" character varying NOT NULL DEFAULT 'employee', "answeredAt" TIMESTAMP WITH TIME ZONE, "endedAt" TIMESTAMP WITH TIME ZONE, "durationSec" integer, "endReason" character varying NOT NULL DEFAULT '', "errorMessage" character varying NOT NULL DEFAULT '', "runId" character varying, "placedByUserId" character varying, "turnCount" integer NOT NULL DEFAULT '0', "silenceCount" integer NOT NULL DEFAULT '0', "replyState" character varying NOT NULL DEFAULT 'idle', "replyTurnId" character varying, "replyStartedAt" TIMESTAMP WITH TIME ZONE, "replyEndsCall" boolean NOT NULL DEFAULT false, "replyDigits" character varying NOT NULL DEFAULT '', "replyText" text NOT NULL DEFAULT '', "brief" text NOT NULL DEFAULT '', "openingLine" text NOT NULL DEFAULT '', "transcriptJson" text NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4257020bbd760c754c4dce0cc78" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1d49ab79c740cb47a9f481d7d9" ON "phone_calls" ("providerSid") WHERE "providerSid" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_06096dce29776d63381e0c60f7" ON "phone_calls" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b7d0dc283b5e5984e84a3c638" ON "phone_calls" ("phoneNumberId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_9b7d0dc283b5e5984e84a3c638"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_06096dce29776d63381e0c60f7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1d49ab79c740cb47a9f481d7d9"`);
        await queryRunner.query(`DROP TABLE "phone_calls"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_05ef91cbb7472194fbdc42b560"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c5e46605b6c675aaef3de35674"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_96eaf4a9fc6dab048fe46b14e7"`);
        await queryRunner.query(`DROP TABLE "phone_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_44549ba65946e6e0cc4f950d90"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f2c8b8c63eb16750bc90ce4451"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_984aaf5aabf5b7b9671c278f66"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e5808ebf94e6660390de3954e1"`);
        await queryRunner.query(`DROP TABLE "phone_numbers"`);
    }

}
