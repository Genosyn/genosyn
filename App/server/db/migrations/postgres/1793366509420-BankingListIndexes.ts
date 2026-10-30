import { MigrationInterface, QueryRunner } from "typeorm";

export class BankingListIndexes1793366509420 implements MigrationInterface {
    name = 'BankingListIndexes1793366509420'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_4fe3f4c6844b2c2d2fe808c5d0" ON "bank_transactions" ("companyId", "date", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_24e7771ade4d294db6bb512fc8" ON "card_transactions" ("companyId", "needsReview", "ledgerEntryId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2b67e254585cab627edc6a26ba" ON "card_transactions" ("companyId", "postedAt", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_2b67e254585cab627edc6a26ba"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_24e7771ade4d294db6bb512fc8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_4fe3f4c6844b2c2d2fe808c5d0"`);
    }

}
