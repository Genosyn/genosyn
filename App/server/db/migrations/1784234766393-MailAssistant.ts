import { MigrationInterface, QueryRunner } from "typeorm";

export class MailAssistant1784234766393 implements MigrationInterface {
    name = 'MailAssistant1784234766393'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_chat_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar, "role" varchar NOT NULL, "employeeId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "suggestionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f7eb88baf09ec0b793dc26b2b7" ON "mail_chat_messages" ("accountId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3dcdd14ce301c4f668cbdf517c" ON "mail_chat_messages" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3dcdd14ce301c4f668cbdf517c"`);
        await queryRunner.query(`DROP INDEX "IDX_f7eb88baf09ec0b793dc26b2b7"`);
        await queryRunner.query(`DROP TABLE "mail_chat_messages"`);
    }

}
