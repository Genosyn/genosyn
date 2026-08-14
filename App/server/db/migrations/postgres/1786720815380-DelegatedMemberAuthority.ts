import { MigrationInterface, QueryRunner } from "typeorm";

export class DelegatedMemberAuthority1786720815380 implements MigrationInterface {
    name = 'DelegatedMemberAuthority1786720815380'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversations" ADD "ownerUserId" character varying`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnRequesterUserId" character varying`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnRequesterSessionVersion" integer`);
        await queryRunner.query(`ALTER TABLE "mail_handovers" ADD "requesterUserId" character varying`);
        await queryRunner.query(`ALTER TABLE "mail_handovers" ADD "requesterSessionVersion" integer`);
        await queryRunner.query(`CREATE INDEX "IDX_69b1bcd350f701be4f6be9bc71" ON "conversations" ("ownerUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3cc780910ce65659fa519621f2" ON "conversation_messages" ("turnRequesterUserId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_3cc780910ce65659fa519621f2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_69b1bcd350f701be4f6be9bc71"`);
        await queryRunner.query(`ALTER TABLE "mail_handovers" DROP COLUMN "requesterSessionVersion"`);
        await queryRunner.query(`ALTER TABLE "mail_handovers" DROP COLUMN "requesterUserId"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnRequesterSessionVersion"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnRequesterUserId"`);
        await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "ownerUserId"`);
    }

}
