import { MigrationInterface, QueryRunner } from "typeorm";

export class BankingSyncStatus1792771037690 implements MigrationInterface {
    name = 'BankingSyncStatus1792771037690'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "syncStartedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "lastSyncAttemptAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "lastSyncError" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "lastSyncErrorDetail" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "lastSyncErrorKind" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "syncFailureCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "nextSyncAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "balanceCents" bigint`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "balanceCurrency" character varying`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" ADD "balanceAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "syncStartedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "lastSyncAttemptAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "lastSyncError" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "lastSyncErrorDetail" text NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "lastSyncErrorKind" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "syncFailureCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "card_feeds" ADD "nextSyncAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "nextSyncAt"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "syncFailureCount"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "lastSyncErrorKind"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "lastSyncErrorDetail"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "lastSyncError"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "lastSyncAttemptAt"`);
        await queryRunner.query(`ALTER TABLE "card_feeds" DROP COLUMN "syncStartedAt"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "balanceAt"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "balanceCurrency"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "balanceCents"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "nextSyncAt"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "syncFailureCount"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "lastSyncErrorKind"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "lastSyncErrorDetail"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "lastSyncError"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "lastSyncAttemptAt"`);
        await queryRunner.query(`ALTER TABLE "bank_feeds" DROP COLUMN "syncStartedAt"`);
    }

}
