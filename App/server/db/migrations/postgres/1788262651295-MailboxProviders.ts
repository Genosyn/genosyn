import { MigrationInterface, QueryRunner } from "typeorm";

export class MailboxProviders1788262651295 implements MigrationInterface {
    name = 'MailboxProviders1788262651295'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "provider" character varying NOT NULL DEFAULT 'gmail'`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "syncCursor" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "mail_messages" ADD "providerLocation" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`CREATE INDEX "IDX_c04d6a0d2725d48bbbeb2b136f" ON "mail_messages" ("accountId", "providerLocation") `);
        await queryRunner.query(`CREATE INDEX "IDX_7524de71140222c20b8f0ea341" ON "mail_messages" ("accountId", "gmailThreadId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_7524de71140222c20b8f0ea341"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c04d6a0d2725d48bbbeb2b136f"`);
        await queryRunner.query(`ALTER TABLE "mail_messages" DROP COLUMN "providerLocation"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "syncCursor"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "provider"`);
    }

}
