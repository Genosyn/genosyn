import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineTimeoutDefault6h1792751607952 implements MigrationInterface {
    name = 'RoutineTimeoutDefault6h1792751607952'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ALTER COLUMN "timeoutSec" SET DEFAULT '21600'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ALTER COLUMN "timeoutSec" SET DEFAULT '3600'`);
    }

}
