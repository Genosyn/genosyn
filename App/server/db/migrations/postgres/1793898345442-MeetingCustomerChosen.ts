import { MigrationInterface, QueryRunner } from "typeorm";

export class MeetingCustomerChosen1793898345442 implements MigrationInterface {
    name = 'MeetingCustomerChosen1793898345442'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "meetings" ADD "customerChosen" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "meetings" DROP COLUMN "customerChosen"`);
    }

}
