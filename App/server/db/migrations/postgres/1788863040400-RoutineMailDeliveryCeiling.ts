import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineMailDeliveryCeiling1788863040400 implements MigrationInterface {
    name = 'RoutineMailDeliveryCeiling1788863040400'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ADD "mailDeliveryMode" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "mailDeliveryMode"`);
    }

}
