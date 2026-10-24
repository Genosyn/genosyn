import { MigrationInterface, QueryRunner } from "typeorm";

export class DropEmployeeOwnedModelColumns1792830885016 implements MigrationInterface {
    name = 'DropEmployeeOwnedModelColumns1792830885016'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_d5513781afa125b0711d25898f"`);
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "employeeId"`);
        await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "isActive"`);
        await queryRunner.query(`ALTER TABLE "ai_models" ALTER COLUMN "companyId" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_models" ALTER COLUMN "companyId" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "isActive" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "ai_models" ADD "employeeId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_d5513781afa125b0711d25898f" ON "ai_models" ("employeeId") `);
    }

}
