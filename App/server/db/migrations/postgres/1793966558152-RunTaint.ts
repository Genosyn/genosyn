import { MigrationInterface, QueryRunner } from "typeorm";

export class RunTaint1793966558152 implements MigrationInterface {
    name = 'RunTaint1793966558152'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" ADD "tainted" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "tainted"`);
    }

}
