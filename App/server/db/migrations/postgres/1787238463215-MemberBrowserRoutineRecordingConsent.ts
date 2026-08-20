import { MigrationInterface, QueryRunner } from "typeorm";

export class MemberBrowserRoutineRecordingConsent1787238463215 implements MigrationInterface {
    name = 'MemberBrowserRoutineRecordingConsent1787238463215'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "member_browsers" ADD "routineRecordingConsentAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "member_browsers" DROP COLUMN "routineRecordingConsentAt"`);
    }

}
