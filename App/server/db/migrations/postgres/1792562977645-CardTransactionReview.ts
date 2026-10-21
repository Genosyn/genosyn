import { MigrationInterface, QueryRunner } from "typeorm";

export class CardTransactionReview1792562977645 implements MigrationInterface {
    name = 'CardTransactionReview1792562977645'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "card_transactions" ADD "needsReview" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "card_transactions" DROP COLUMN "needsReview"`);
    }

}
