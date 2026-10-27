import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerChannels1793101984992 implements MigrationInterface {
    name = 'CustomerChannels1793101984992'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_channels" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "provider" character varying NOT NULL, "connectionId" character varying NOT NULL, "externalChannelId" character varying NOT NULL, "name" character varying NOT NULL DEFAULT '', "shared" boolean NOT NULL DEFAULT false, "customerId" character varying NOT NULL, "employeeId" character varying, "replyMode" character varying NOT NULL DEFAULT 'mentions', "instructions" text NOT NULL DEFAULT '', "lastMessageAt" TIMESTAMP WITH TIME ZONE, "lastNotedAt" TIMESTAMP WITH TIME ZONE, "notesAttemptedAt" TIMESTAMP WITH TIME ZONE, "notesError" character varying NOT NULL DEFAULT '', "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6958c9a6f6486c5f7cd69a42dab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59edb28352b07dc192a08de387" ON "customer_channels" ("connectionId", "externalChannelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f055625c2277b20bf798ca4af6" ON "customer_channels" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_915b69c75b6259144c119af025" ON "customer_channels" ("customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_079e044ec787cf91aa94e4e406" ON "customer_channels" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "customer_channel_messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "customerChannelId" character varying NOT NULL, "externalMessageId" character varying, "threadKey" character varying NOT NULL DEFAULT '', "authorKind" character varying NOT NULL, "authorExternalId" character varying NOT NULL DEFAULT '', "authorLabel" character varying NOT NULL DEFAULT '', "postedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "notedAt" TIMESTAMP WITH TIME ZONE, "replyClaimedAt" TIMESTAMP WITH TIME ZONE, "text" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_048284b37dd4f50958c6a16ac1e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_34bab4799226c44730d1ecdee5" ON "customer_channel_messages" ("customerChannelId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_84ee681f3b6e000d83f4525c94" ON "customer_channel_messages" ("customerChannelId", "threadKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_8c2477f192776a07cf6a117d17" ON "customer_channel_messages" ("customerChannelId", "notedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8f73673f61e87f51baf63ac661" ON "customer_channel_messages" ("customerChannelId", "postedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_24de96a7f55847ab7e712263f6" ON "customer_channel_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_24de96a7f55847ab7e712263f6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8f73673f61e87f51baf63ac661"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8c2477f192776a07cf6a117d17"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_84ee681f3b6e000d83f4525c94"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_34bab4799226c44730d1ecdee5"`);
        await queryRunner.query(`DROP TABLE "customer_channel_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_079e044ec787cf91aa94e4e406"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_915b69c75b6259144c119af025"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f055625c2277b20bf798ca4af6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_59edb28352b07dc192a08de387"`);
        await queryRunner.query(`DROP TABLE "customer_channels"`);
    }

}
