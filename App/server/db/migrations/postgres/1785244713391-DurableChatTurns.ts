import { MigrationInterface, QueryRunner } from "typeorm";

export class DurableChatTurns1785244713391 implements MigrationInterface {
    name = 'DurableChatTurns1785244713391'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "progressPercent" integer`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "progressLabel" character varying`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "updatedAt"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "progressLabel"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "progressPercent"`);
    }

}
