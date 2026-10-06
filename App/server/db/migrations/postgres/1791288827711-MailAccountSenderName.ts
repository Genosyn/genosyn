import { MigrationInterface, QueryRunner } from "typeorm";

export class MailAccountSenderName1791288827711 implements MigrationInterface {
    name = 'MailAccountSenderName1791288827711'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "senderName" character varying NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "senderName"`);
    }

}
