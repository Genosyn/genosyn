import { MigrationInterface, QueryRunner } from "typeorm";

export class SupportChatWidget1793904310621 implements MigrationInterface {
    name = 'SupportChatWidget1793904310621'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "support_chat_visitors" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "widgetId" character varying NOT NULL, "tokenHash" character varying, "name" character varying NOT NULL DEFAULT '', "email" character varying NOT NULL DEFAULT '', "emailConfirmedAt" TIMESTAMP WITH TIME ZONE, "pendingEmail" character varying NOT NULL DEFAULT '', "pendingEmailTokenHash" character varying, "pendingEmailSentAt" TIMESTAMP WITH TIME ZONE, "lastSeq" integer NOT NULL DEFAULT '0', "readSeq" integer NOT NULL DEFAULT '0', "emailedSeq" integer NOT NULL DEFAULT '0', "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_27883687750ad09b214f051e005" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_172dbd511ac1943d72af436d3f" ON "support_chat_visitors" ("lastSeq", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7089eff9059be942d6880b15e3" ON "support_chat_visitors" ("pendingEmailTokenHash") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8821b2cab37a632f1d82ed4d40" ON "support_chat_visitors" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_319ea757f193833941ae3fe3f6" ON "support_chat_visitors" ("widgetId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3cf725b8a0411afc2974c6dac7" ON "support_chat_visitors" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "support_chat_widgets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "inboxId" character varying NOT NULL, "publicKey" character varying NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "title" character varying NOT NULL DEFAULT '', "updatedByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "greeting" text NOT NULL DEFAULT '', "allowedOriginsJson" text NOT NULL DEFAULT '[]', CONSTRAINT "PK_9f4a2787ca3b3d1a77e5fef2842" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_df61c4113b6d36abc5ebd01efa" ON "support_chat_widgets" ("publicKey") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_99c9906f7bad9a449bc7c7f33d" ON "support_chat_widgets" ("inboxId") `);
        await queryRunner.query(`CREATE INDEX "IDX_978b23ed147ee52d10709f75a5" ON "support_chat_widgets" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "support_settings" ADD "chatMessagesPerHour" integer NOT NULL DEFAULT '600'`);
        await queryRunner.query(`ALTER TABLE "support_settings" ADD "chatAiTurnsPerDay" integer NOT NULL DEFAULT '200'`);
        await queryRunner.query(`ALTER TABLE "support_tickets" ADD "chatVisitorId" character varying`);
        await queryRunner.query(`ALTER TABLE "support_messages" ADD "chatVisitorId" character varying`);
        await queryRunner.query(`ALTER TABLE "support_messages" ADD "chatSeq" integer`);
        await queryRunner.query(`ALTER TABLE "support_messages" ADD "chatClientId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_463d26361ad573182ee445d42c" ON "auth_rate_limits" ("updatedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_4b08755deab1f6eef84edcdc88" ON "support_tickets" ("chatVisitorId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_1f564ba4eac52ce33dc66bb905" ON "support_tickets" ("companyId", "source", "lastActivityAt", "id") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_31b602f70cea32a72c2bc1e2f9" ON "support_messages" ("chatVisitorId", "chatClientId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ee8e4df4d7f03892c95f06f79f" ON "support_messages" ("chatVisitorId", "chatSeq") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_ee8e4df4d7f03892c95f06f79f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_31b602f70cea32a72c2bc1e2f9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1f564ba4eac52ce33dc66bb905"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4b08755deab1f6eef84edcdc88"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_463d26361ad573182ee445d42c"`);
        await queryRunner.query(`ALTER TABLE "support_messages" DROP COLUMN "chatClientId"`);
        await queryRunner.query(`ALTER TABLE "support_messages" DROP COLUMN "chatSeq"`);
        await queryRunner.query(`ALTER TABLE "support_messages" DROP COLUMN "chatVisitorId"`);
        await queryRunner.query(`ALTER TABLE "support_tickets" DROP COLUMN "chatVisitorId"`);
        await queryRunner.query(`ALTER TABLE "support_settings" DROP COLUMN "chatAiTurnsPerDay"`);
        await queryRunner.query(`ALTER TABLE "support_settings" DROP COLUMN "chatMessagesPerHour"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_978b23ed147ee52d10709f75a5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_99c9906f7bad9a449bc7c7f33d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_df61c4113b6d36abc5ebd01efa"`);
        await queryRunner.query(`DROP TABLE "support_chat_widgets"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3cf725b8a0411afc2974c6dac7"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_319ea757f193833941ae3fe3f6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8821b2cab37a632f1d82ed4d40"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7089eff9059be942d6880b15e3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_172dbd511ac1943d72af436d3f"`);
        await queryRunner.query(`DROP TABLE "support_chat_visitors"`);
    }

}
