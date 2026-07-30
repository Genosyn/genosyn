import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatTurnModel1785408400907 implements MigrationInterface {
    name = 'ChatTurnModel1785408400907'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "modelId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "modelId"`);
    }

}
