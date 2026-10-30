import { MigrationInterface, QueryRunner } from "typeorm";

export class AIModelKeySessions1793364477239 implements MigrationInterface {
    name = 'AIModelKeySessions1793364477239'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_model_key_health" ADD "sessionsByHour" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_model_key_health" DROP COLUMN "sessionsByHour"`);
    }

}
