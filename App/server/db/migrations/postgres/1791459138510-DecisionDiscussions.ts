import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionDiscussions1791459138510 implements MigrationInterface {
    name = 'DecisionDiscussions1791459138510'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversations" ADD "discussedDecisionId" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_11107f72f0e23051f012c69f3e" ON "conversations" ("discussedDecisionId", "ownerUserId") WHERE "discussedDecisionId" IS NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_11107f72f0e23051f012c69f3e"`);
        await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "discussedDecisionId"`);
    }

}
