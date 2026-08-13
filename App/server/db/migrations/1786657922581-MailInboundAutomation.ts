import { MigrationInterface, QueryRunner } from "typeorm";

export class MailInboundAutomation1786657922581 implements MigrationInterface {
    name = 'MailInboundAutomation1786657922581'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_inbound_automations" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "messageId" varchar NOT NULL, "gmailMessageId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "startedAt" datetime, "finishedAt" datetime, "errorMessage" text NOT NULL DEFAULT (''), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_438e9420a58d8aa65248015eba" ON "mail_inbound_automations" ("accountId", "gmailMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1f9d0610019d15efd7b268f78b" ON "mail_inbound_automations" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_37119ff972d910cd0077893a89" ON "mail_inbound_automations" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_37119ff972d910cd0077893a89"`);
        await queryRunner.query(`DROP INDEX "IDX_1f9d0610019d15efd7b268f78b"`);
        await queryRunner.query(`DROP INDEX "IDX_438e9420a58d8aa65248015eba"`);
        await queryRunner.query(`DROP TABLE "mail_inbound_automations"`);
    }

}
