import { MigrationInterface, QueryRunner } from "typeorm";

export class BrowserSessionRunIndex1787240615184 implements MigrationInterface {
    name = 'BrowserSessionRunIndex1787240615184'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_d680372f43ccddadc82d6293d1" ON "browser_sessions" ("runId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d680372f43ccddadc82d6293d1"`);
    }

}
