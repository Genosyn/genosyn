import { MigrationInterface, QueryRunner } from "typeorm";

export class PagingLeftoverIndexes1793396542896 implements MigrationInterface {
    name = 'PagingLeftoverIndexes1793396542896'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_e46fa6635be01a4fba56dd98c4"`);
        await queryRunner.query(`DROP INDEX "IDX_a4c488d49a53802623d18884fd"`);
        await queryRunner.query(`DROP INDEX "IDX_94aa9cdb289d03202f0bf2bfef"`);
        await queryRunner.query(`CREATE INDEX "IDX_3ce2b4945ce4091efa93345060" ON "channel_messages" ("channelId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_404114a86dd8fcf856f2ad2cca" ON "contacts" ("companyId", "lifecycleStage", "lastActivityAt", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_cf48ad179cce4f501ed10f5dc6" ON "activities" ("companyId", "occurredAt", "createdAt", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_cf48ad179cce4f501ed10f5dc6"`);
        await queryRunner.query(`DROP INDEX "IDX_404114a86dd8fcf856f2ad2cca"`);
        await queryRunner.query(`DROP INDEX "IDX_3ce2b4945ce4091efa93345060"`);
        await queryRunner.query(`CREATE INDEX "IDX_94aa9cdb289d03202f0bf2bfef" ON "activities" ("companyId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a4c488d49a53802623d18884fd" ON "contacts" ("companyId", "lifecycleStage") `);
        await queryRunner.query(`CREATE INDEX "IDX_e46fa6635be01a4fba56dd98c4" ON "channel_messages" ("channelId", "createdAt") `);
    }

}
