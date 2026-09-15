import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionSnoozing1789500662061 implements MigrationInterface {
    name = 'DecisionSnoozing1789500662061'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "decisions" ADD "snoozedUntil" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_da1e2f94c4a2a884b9688643f7" ON "decisions" ("status", "snoozedUntil") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_da1e2f94c4a2a884b9688643f7"`);
        await queryRunner.query(`ALTER TABLE "decisions" DROP COLUMN "snoozedUntil"`);
    }

}
