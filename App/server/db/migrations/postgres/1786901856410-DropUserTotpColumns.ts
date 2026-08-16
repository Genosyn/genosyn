import { MigrationInterface, QueryRunner } from "typeorm";

export class DropUserTotpColumns1786901856410 implements MigrationInterface {
    name = 'DropUserTotpColumns1786901856410'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "totpEnabledAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "totpSecret"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "totpSecret" text`);
        await queryRunner.query(`ALTER TABLE "users" ADD "totpEnabledAt" TIMESTAMP WITH TIME ZONE`);
    }

}
