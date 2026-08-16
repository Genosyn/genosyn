import { MigrationInterface, QueryRunner } from "typeorm";

export class MailChatMessageModel1786903131444 implements MigrationInterface {
    name = 'MailChatMessageModel1786903131444'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3dcdd14ce301c4f668cbdf517c"`);
        await queryRunner.query(`DROP INDEX "IDX_f7eb88baf09ec0b793dc26b2b7"`);
        await queryRunner.query(`CREATE TABLE "temporary_mail_chat_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar, "role" varchar NOT NULL, "employeeId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "suggestionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "modelId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_mail_chat_messages"("id", "companyId", "accountId", "threadId", "role", "employeeId", "content", "status", "actionsJson", "suggestionsJson", "createdByUserId", "createdAt") SELECT "id", "companyId", "accountId", "threadId", "role", "employeeId", "content", "status", "actionsJson", "suggestionsJson", "createdByUserId", "createdAt" FROM "mail_chat_messages"`);
        await queryRunner.query(`DROP TABLE "mail_chat_messages"`);
        await queryRunner.query(`ALTER TABLE "temporary_mail_chat_messages" RENAME TO "mail_chat_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_3dcdd14ce301c4f668cbdf517c" ON "mail_chat_messages" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_f7eb88baf09ec0b793dc26b2b7" ON "mail_chat_messages" ("accountId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_f7eb88baf09ec0b793dc26b2b7"`);
        await queryRunner.query(`DROP INDEX "IDX_3dcdd14ce301c4f668cbdf517c"`);
        await queryRunner.query(`ALTER TABLE "mail_chat_messages" RENAME TO "temporary_mail_chat_messages"`);
        await queryRunner.query(`CREATE TABLE "mail_chat_messages" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar, "role" varchar NOT NULL, "employeeId" varchar, "content" text NOT NULL DEFAULT (''), "status" varchar, "actionsJson" text NOT NULL DEFAULT (''), "suggestionsJson" text NOT NULL DEFAULT (''), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "mail_chat_messages"("id", "companyId", "accountId", "threadId", "role", "employeeId", "content", "status", "actionsJson", "suggestionsJson", "createdByUserId", "createdAt") SELECT "id", "companyId", "accountId", "threadId", "role", "employeeId", "content", "status", "actionsJson", "suggestionsJson", "createdByUserId", "createdAt" FROM "temporary_mail_chat_messages"`);
        await queryRunner.query(`DROP TABLE "temporary_mail_chat_messages"`);
        await queryRunner.query(`CREATE INDEX "IDX_f7eb88baf09ec0b793dc26b2b7" ON "mail_chat_messages" ("accountId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_3dcdd14ce301c4f668cbdf517c" ON "mail_chat_messages" ("companyId") `);
    }

}
