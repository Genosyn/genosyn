import { MigrationInterface, QueryRunner } from "typeorm";

export class MailAnalysisInstructions1791525569868 implements MigrationInterface {
    name = 'MailAnalysisInstructions1791525569868'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "aiAnalysisInstructions" text`);
        await queryRunner.query(`ALTER TABLE "mail_inbound_analyses" ADD "autoActionsJson" text NOT NULL DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_inbound_analyses" DROP COLUMN "autoActionsJson"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "aiAnalysisInstructions"`);
    }

}
