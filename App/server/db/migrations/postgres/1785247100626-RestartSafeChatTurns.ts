import { MigrationInterface, QueryRunner } from "typeorm";

export class RestartSafeChatTurns1785247100626 implements MigrationInterface {
    name = 'RestartSafeChatTurns1785247100626'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnUserMessageId" character varying`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnWorkerId" character varying`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnLeaseExpiresAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnAttempt" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" ADD "turnDeadlineAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "workload_leases" ADD "ownerKey" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_ae7fbbd7b13eea7fc3a0d484ac" ON "conversation_messages" ("turnUserMessageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c84e95351b2ffc5a48b7181652" ON "conversation_messages" ("turnLeaseExpiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_777e76e3d7ebbeec8617ea15ba" ON "workload_leases" ("ownerKey") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_777e76e3d7ebbeec8617ea15ba"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c84e95351b2ffc5a48b7181652"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ae7fbbd7b13eea7fc3a0d484ac"`);
        await queryRunner.query(`ALTER TABLE "workload_leases" DROP COLUMN "ownerKey"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnDeadlineAt"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnAttempt"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnLeaseExpiresAt"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnWorkerId"`);
        await queryRunner.query(`ALTER TABLE "conversation_messages" DROP COLUMN "turnUserMessageId"`);
    }

}
