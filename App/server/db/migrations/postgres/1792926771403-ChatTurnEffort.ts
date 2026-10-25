import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatTurnEffort1792926771403 implements MigrationInterface {
    name = 'ChatTurnEffort1792926771403'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "effort" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "effort"`);
    }

}
