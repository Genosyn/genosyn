import { MigrationInterface, QueryRunner } from "typeorm";

export class RunRoutineStartedIndex1782500000000 implements MigrationInterface {
    name = 'RunRoutineStartedIndex1782500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_256fc3e671f60318bb6a3c26d7" ON "runs" ("routineId", "startedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_256fc3e671f60318bb6a3c26d7"`);
    }

}
