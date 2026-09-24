import { MigrationInterface, QueryRunner } from "typeorm";

export class EmployeeRoutineQueue1790272426383 implements MigrationInterface {
    name = 'EmployeeRoutineQueue1790272426383'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" ADD "employeeId" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "queueActiveEmployeeId" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "queueOptionsJson" text`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_62e3c170e93f23c5be78832c47" ON "runs" ("queueActiveEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_291c1c0c98b298f8ea7fb7426b" ON "runs" ("employeeId", "status", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_291c1c0c98b298f8ea7fb7426b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_62e3c170e93f23c5be78832c47"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "queueOptionsJson"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "queueActiveEmployeeId"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "employeeId"`);
    }

}
