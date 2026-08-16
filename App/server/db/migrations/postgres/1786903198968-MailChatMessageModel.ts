import { MigrationInterface, QueryRunner } from "typeorm";

export class MailChatMessageModel1786903198968 implements MigrationInterface {
    name = 'MailChatMessageModel1786903198968'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_chat_messages" ADD "modelId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_chat_messages" DROP COLUMN "modelId"`);
    }

}
