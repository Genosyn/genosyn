import { MigrationInterface, QueryRunner } from "typeorm";

export class ExternalChatSurfaces1788204122387 implements MigrationInterface {
    name = 'ExternalChatSurfaces1788204122387'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "external_chat_identities" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "provider" character varying NOT NULL, "connectionId" character varying NOT NULL, "externalUserId" character varying NOT NULL, "externalUserLabel" character varying, "userId" character varying, "boundAt" TIMESTAMP WITH TIME ZONE, "boundSessionVersion" integer, "boundVia" character varying, "linkTokenHash" character varying, "linkExpiresAt" TIMESTAMP WITH TIME ZONE, "lastSeenAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d4578c570458a087e39b94d0f71" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7ebc4cb41fbdd562dbdf945c69" ON "external_chat_identities" ("connectionId", "externalUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eb664fbbdd672904b9717d04f1" ON "external_chat_identities" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9e1fb4655017f013247adb4baa" ON "external_chat_identities" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "externalMessageId" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_982a58de1229f74c36fb77b12b" ON "conversation_messages" ("conversationId", "externalMessageId") WHERE "externalMessageId" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_982a58de1229f74c36fb77b12b"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "externalMessageId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9e1fb4655017f013247adb4baa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eb664fbbdd672904b9717d04f1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7ebc4cb41fbdd562dbdf945c69"`);
        await queryRunner.query(`DROP TABLE "external_chat_identities"`);
    }

}
