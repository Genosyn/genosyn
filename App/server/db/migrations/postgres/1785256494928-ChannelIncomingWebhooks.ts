import { MigrationInterface, QueryRunner } from "typeorm";

export class ChannelIncomingWebhooks1785256494928 implements MigrationInterface {
    name = 'ChannelIncomingWebhooks1785256494928'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channels" ADD "webhookToken" character varying`);
        await queryRunner.query(`ALTER TABLE "channel_messages" ADD "authorName" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channel_messages" DROP COLUMN "authorName"`);
        await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN "webhookToken"`);
    }

}
