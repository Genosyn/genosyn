import { MigrationInterface, QueryRunner } from "typeorm";

export class RunFailureStates1789639755119 implements MigrationInterface {
    name = 'RunFailureStates1789639755119'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" ADD "errorKind" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "failureReason" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "failureReason"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "errorKind"`);
    }

}
