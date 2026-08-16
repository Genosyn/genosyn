import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatContextUsage1786873003731 implements MigrationInterface {
    name = 'ChatContextUsage1786873003731'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "contextTokens" integer`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "contextWindow" integer`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "contextWindow"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "contextTokens"`);
    }

}
