import { MigrationInterface, QueryRunner } from "typeorm";

export class OffBoxBackupRetention1792650541704 implements MigrationInterface {
    name = 'OffBoxBackupRetention1792650541704'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "backup_schedules" ADD "offBoxRetentionEnabled" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "backup_schedules" ADD "offBoxRetentionDays" integer NOT NULL DEFAULT '30'`);
        await queryRunner.query(`ALTER TABLE "backup_destinations" ADD "lastAttemptAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "backup_destinations" ADD "failingSince" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "backup_destinations" ADD "lastAlertedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "backup_destinations" DROP COLUMN "lastAlertedAt"`);
        await queryRunner.query(`ALTER TABLE "backup_destinations" DROP COLUMN "failingSince"`);
        await queryRunner.query(`ALTER TABLE "backup_destinations" DROP COLUMN "lastAttemptAt"`);
        await queryRunner.query(`ALTER TABLE "backup_schedules" DROP COLUMN "offBoxRetentionDays"`);
        await queryRunner.query(`ALTER TABLE "backup_schedules" DROP COLUMN "offBoxRetentionEnabled"`);
    }

}
