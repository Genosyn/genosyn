import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineAiAccess1791275770255 implements MigrationInterface {
    name = 'RoutineAiAccess1791275770255'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "employee_routine_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'write', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6b551c431575952f9d4370fc828" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dd1de6f2e340986c7d0699080f" ON "employee_routine_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_05827483caea00ecfeca8314e5" ON "employee_routine_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_05827483caea00ecfeca8314e5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dd1de6f2e340986c7d0699080f"`);
        await queryRunner.query(`DROP TABLE "employee_routine_grants"`);
    }

}
