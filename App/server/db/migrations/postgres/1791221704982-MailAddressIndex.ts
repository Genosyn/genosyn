import { MigrationInterface, QueryRunner } from "typeorm";

export class MailAddressIndex1791221704982 implements MigrationInterface {
    name = 'MailAddressIndex1791221704982'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "mail_message_addresses" ("messageId" character varying NOT NULL, "address" character varying NOT NULL, "companyId" character varying NOT NULL, "accountId" character varying NOT NULL, "baseDomain" character varying NOT NULL, CONSTRAINT "PK_04e2fefbf36bcd5cecf02575398" PRIMARY KEY ("messageId", "address"))`);
        await queryRunner.query(`CREATE INDEX "IDX_06c8b3a64971983efb8750df51" ON "mail_message_addresses" ("accountId") `);
        await queryRunner.query(`CREATE INDEX "IDX_35da8a03a301be3f89adfb3a0a" ON "mail_message_addresses" ("companyId", "baseDomain") `);
        await queryRunner.query(`CREATE INDEX "IDX_a7b15de6af2625b35c943272eb" ON "mail_message_addresses" ("companyId", "address") `);
        await queryRunner.query(`CREATE TABLE "mail_address_index_states" ("accountId" character varying NOT NULL, "companyId" character varying NOT NULL, "cursorAt" character varying NOT NULL DEFAULT '', "cursorId" character varying NOT NULL DEFAULT '', "caughtUpAt" TIMESTAMP WITH TIME ZONE, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7b262544f84bfdb06c58a43eace" PRIMARY KEY ("accountId"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cc3adb100b1e15ed765f0a7e2c" ON "mail_address_index_states" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_cc3adb100b1e15ed765f0a7e2c"`);
        await queryRunner.query(`DROP TABLE "mail_address_index_states"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a7b15de6af2625b35c943272eb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_35da8a03a301be3f89adfb3a0a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_06c8b3a64971983efb8750df51"`);
        await queryRunner.query(`DROP TABLE "mail_message_addresses"`);
    }

}
