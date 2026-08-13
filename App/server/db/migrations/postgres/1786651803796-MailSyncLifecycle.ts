import { MigrationInterface, QueryRunner } from "typeorm";

export class MailSyncLifecycle1786651803796 implements MigrationInterface {
    name = 'MailSyncLifecycle1786651803796'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "syncState" character varying NOT NULL DEFAULT 'idle'`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "syncAttemptId" character varying`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "syncStartedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" ADD "syncFinishedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "syncFinishedAt"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "syncStartedAt"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "syncAttemptId"`);
        await queryRunner.query(`ALTER TABLE "mail_accounts" DROP COLUMN "syncState"`);
    }

}
