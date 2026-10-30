import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatThinkingLevels1793381568847 implements MigrationInterface {
    name = 'ChatThinkingLevels1793381568847'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "defaultEffort" character varying`);
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "effortCeiling" character varying`);
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "customThinkingLevels" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "conversations" ADD "effort" character varying`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "thinkingJson" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "thinkingJson"`);
        await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "effort"`);
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "customThinkingLevels"`);
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "effortCeiling"`);
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "defaultEffort"`);
    }

}
