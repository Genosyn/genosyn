import { MigrationInterface, QueryRunner } from "typeorm";

export class MailInboundAutomation1786657959200 implements MigrationInterface {
    name = 'MailInboundAutomation1786657959200'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_inbound_automations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "accountId" character varying NOT NULL, "messageId" character varying NOT NULL, "gmailMessageId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'queued', "startedAt" TIMESTAMP WITH TIME ZONE, "finishedAt" TIMESTAMP WITH TIME ZONE, "errorMessage" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_64ddf157cf6fa7782df34badcb9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_438e9420a58d8aa65248015eba" ON "mail_inbound_automations" ("accountId", "gmailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1f9d0610019d15efd7b268f78b" ON "mail_inbound_automations" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_37119ff972d910cd0077893a89" ON "mail_inbound_automations" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_37119ff972d910cd0077893a89"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1f9d0610019d15efd7b268f78b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_438e9420a58d8aa65248015eba"`);
        await queryRunner.query(`DROP TABLE "mail_inbound_automations"`);
    }

}
