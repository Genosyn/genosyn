import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatWorkloadLeaseScope1787668845013 implements MigrationInterface {
    name = 'ChatWorkloadLeaseScope1787668845013'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "workload_leases" ADD "scopeKey" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_0d42db6234525bb0da833e1954" ON "workload_leases" ("employeeId", "kind", "scopeKey") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_0d42db6234525bb0da833e1954"`);
        await queryRunner.query(`ALTER TABLE "workload_leases" DROP COLUMN "scopeKey"`);
    }

}
