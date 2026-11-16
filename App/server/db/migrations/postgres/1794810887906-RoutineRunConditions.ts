import { MigrationInterface, QueryRunner } from "typeorm";

export class RoutineRunConditions1794810887906 implements MigrationInterface {
    name = 'RoutineRunConditions1794810887906'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "routines" ADD "runCondition" character varying NOT NULL DEFAULT 'always'`);
        await queryRunner.query(`ALTER TABLE "routines" ADD "nothingDueAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "routines" ADD "nothingDueCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "workstreams" ADD "revisitAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_a723deea0280ca1e92bb7f30df" ON "workstreams" ("employeeId", "status", "revisitAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a723deea0280ca1e92bb7f30df"`);
        await queryRunner.query(`ALTER TABLE "workstreams" DROP COLUMN "revisitAt"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "nothingDueCount"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "nothingDueAt"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "runCondition"`);
    }

}
