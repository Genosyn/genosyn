import { MigrationInterface, QueryRunner } from "typeorm";

export class CustomerChannels1793101921645 implements MigrationInterface {
    name = 'CustomerChannels1793101921645'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_channels" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "provider" varchar NOT NULL, "connectionId" varchar NOT NULL, "externalChannelId" varchar NOT NULL, "name" varchar NOT NULL DEFAULT (''), "shared" boolean NOT NULL DEFAULT (0), "customerId" varchar NOT NULL, "employeeId" varchar, "replyMode" varchar NOT NULL DEFAULT ('mentions'), "instructions" text NOT NULL DEFAULT (''), "lastMessageAt" datetime, "lastNotedAt" datetime, "notesAttemptedAt" datetime, "notesError" varchar NOT NULL DEFAULT (''), "createdById" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_59edb28352b07dc192a08de387" ON "customer_channels" ("connectionId", "externalChannelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f055625c2277b20bf798ca4af6" ON "customer_channels" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_915b69c75b6259144c119af025" ON "customer_channels" ("customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_079e044ec787cf91aa94e4e406" ON "customer_channels" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "customer_channel_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "customerChannelId" varchar NOT NULL, "externalMessageId" varchar, "threadKey" varchar NOT NULL DEFAULT (''), "authorKind" varchar NOT NULL, "authorExternalId" varchar NOT NULL DEFAULT (''), "authorLabel" varchar NOT NULL DEFAULT (''), "postedAt" datetime NOT NULL, "notedAt" datetime, "replyClaimedAt" datetime, "text" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_34bab4799226c44730d1ecdee5" ON "customer_channel_messages" ("customerChannelId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_84ee681f3b6e000d83f4525c94" ON "customer_channel_messages" ("customerChannelId", "threadKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_8c2477f192776a07cf6a117d17" ON "customer_channel_messages" ("customerChannelId", "notedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_8f73673f61e87f51baf63ac661" ON "customer_channel_messages" ("customerChannelId", "postedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_24de96a7f55847ab7e712263f6" ON "customer_channel_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_24de96a7f55847ab7e712263f6"`);
        await queryRunner.query(`DROP INDEX "IDX_8f73673f61e87f51baf63ac661"`);
        await queryRunner.query(`DROP INDEX "IDX_8c2477f192776a07cf6a117d17"`);
        await queryRunner.query(`DROP INDEX "IDX_84ee681f3b6e000d83f4525c94"`);
        await queryRunner.query(`DROP INDEX "IDX_34bab4799226c44730d1ecdee5"`);
        await queryRunner.query(`DROP TABLE "customer_channel_messages"`);
        await queryRunner.query(`DROP INDEX "IDX_079e044ec787cf91aa94e4e406"`);
        await queryRunner.query(`DROP INDEX "IDX_915b69c75b6259144c119af025"`);
        await queryRunner.query(`DROP INDEX "IDX_f055625c2277b20bf798ca4af6"`);
        await queryRunner.query(`DROP INDEX "IDX_59edb28352b07dc192a08de387"`);
        await queryRunner.query(`DROP TABLE "customer_channels"`);
    }

}
