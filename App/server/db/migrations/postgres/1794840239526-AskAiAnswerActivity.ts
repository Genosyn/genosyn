import { MigrationInterface, QueryRunner } from "typeorm";

export class AskAiAnswerActivity1794840239526 implements MigrationInterface {
    name = 'AskAiAnswerActivity1794840239526'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ask_ai_messages" ADD "activityJson" text NOT NULL DEFAULT ''`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ask_ai_messages" DROP COLUMN "activityJson"`);
    }

}
