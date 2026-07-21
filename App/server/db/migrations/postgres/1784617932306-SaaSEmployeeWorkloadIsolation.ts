import { MigrationInterface, QueryRunner } from "typeorm";

export class SaaSEmployeeWorkloadIsolation1784617932306 implements MigrationInterface {
    name = "SaaSEmployeeWorkloadIsolation1784617932306";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workload_leases" ADD "employeeId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_e527e54bbcbbad3c7a2dac6153" ON "workload_leases" ("employeeId", "expiresAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_e527e54bbcbbad3c7a2dac6153"`);
        await queryRunner.query(`ALTER TABLE "workload_leases" DROP COLUMN "employeeId"`);
    }
}
