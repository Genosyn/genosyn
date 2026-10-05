import { MigrationInterface, QueryRunner } from "typeorm";

export class MailAddressIndex1791221197665 implements MigrationInterface {
    name = 'MailAddressIndex1791221197665'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_message_addresses" ("messageId" varchar NOT NULL, "address" varchar NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "baseDomain" varchar NOT NULL, PRIMARY KEY ("messageId", "address"))`);
        await queryRunner.query(`CREATE INDEX "IDX_06c8b3a64971983efb8750df51" ON "mail_message_addresses" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_35da8a03a301be3f89adfb3a0a" ON "mail_message_addresses" ("companyId", "baseDomain") `);
        await queryRunner.query(`CREATE INDEX "IDX_a7b15de6af2625b35c943272eb" ON "mail_message_addresses" ("companyId", "address") `);
        await queryRunner.query(`CREATE TABLE "mail_address_index_states" ("accountId" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "cursorAt" varchar NOT NULL DEFAULT (''), "cursorId" varchar NOT NULL DEFAULT (''), "caughtUpAt" datetime, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_cc3adb100b1e15ed765f0a7e2c" ON "mail_address_index_states" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_cc3adb100b1e15ed765f0a7e2c"`);
        await queryRunner.query(`DROP TABLE "mail_address_index_states"`);
        await queryRunner.query(`DROP INDEX "IDX_a7b15de6af2625b35c943272eb"`);
        await queryRunner.query(`DROP INDEX "IDX_35da8a03a301be3f89adfb3a0a"`);
        await queryRunner.query(`DROP INDEX "IDX_06c8b3a64971983efb8750df51"`);
        await queryRunner.query(`DROP TABLE "mail_message_addresses"`);
    }

}
