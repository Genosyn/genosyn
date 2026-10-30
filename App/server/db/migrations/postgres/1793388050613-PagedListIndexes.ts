import { MigrationInterface, QueryRunner } from "typeorm";

export class PagedListIndexes1793388050613 implements MigrationInterface {
    name = 'PagedListIndexes1793388050613'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_eeef4a3165dc6b0548253c3e9a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bb6566684b7205f61bf30e5d1f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d5537f603bea9afe80ae9fba7c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c45581301c84a8b96f4f5174cc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a1ce15f3420232b32ede42fdcc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_05ef91cbb7472194fbdc42b560"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9b7d0dc283b5e5984e84a3c638"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_49668653e3a1bbf3bfe35dfc7d"`);
        await queryRunner.query(`CREATE INDEX "IDX_7b6ffeaf13baf14c37bb7d6a94" ON "approvals" ("employeeId", "kind", "requestedAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_0b0c4e07bc940ae835aa8757e6" ON "channel_messages" ("channelId", "deletedAt", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f0906c7b54d259d7cc98e6952a" ON "pipeline_runs" ("pipelineId", "status", "startedAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_a7178d9954756abe7aa7601a97" ON "pipeline_runs" ("pipelineId", "startedAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_b42c27a125f7507f7b14b2af8c" ON "notes" ("companyId", "updatedAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e60eefe999d4a9a289decb062f" ON "notes" ("companyId", "sortOrder", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_c9d86fbb64cf60ac0fa9d2c26f" ON "signature_envelopes" ("companyId", "customerId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_732efc3eac4442ecaf126ea01a" ON "signature_envelopes" ("companyId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_49f558e5ebedb2ca792c3a59f3" ON "signature_envelopes" ("companyId", "status", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_fbf86e3534550fa28c679670c3" ON "contacts" ("companyId", "lastActivityAt", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_8649c95ce2b854ad25e69bb252" ON "recruiting_applications" ("openingId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_bc8edd496de1d3da979767f7d4" ON "recruiting_applications" ("companyId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_e966c74e4e499e2135acd99467" ON "phone_messages" ("phoneNumberId", "occurredAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_78b7e4b388e79fd99a569fa95d" ON "phone_calls" ("phoneNumberId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f2e9f8ef6aeec4ec8e527bc018" ON "data_room_questions" ("roomId", "createdAt", "id") `);
        await queryRunner.query(`CREATE INDEX "IDX_85f86d42de97732c3948622390" ON "data_room_questions" ("roomId", "status", "createdAt", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_85f86d42de97732c3948622390"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f2e9f8ef6aeec4ec8e527bc018"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_78b7e4b388e79fd99a569fa95d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e966c74e4e499e2135acd99467"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bc8edd496de1d3da979767f7d4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8649c95ce2b854ad25e69bb252"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fbf86e3534550fa28c679670c3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_49f558e5ebedb2ca792c3a59f3"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_732efc3eac4442ecaf126ea01a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c9d86fbb64cf60ac0fa9d2c26f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e60eefe999d4a9a289decb062f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b42c27a125f7507f7b14b2af8c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a7178d9954756abe7aa7601a97"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f0906c7b54d259d7cc98e6952a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0b0c4e07bc940ae835aa8757e6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7b6ffeaf13baf14c37bb7d6a94"`);
        await queryRunner.query(`CREATE INDEX "IDX_49668653e3a1bbf3bfe35dfc7d" ON "data_room_questions" ("roomId", "status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b7d0dc283b5e5984e84a3c638" ON "phone_calls" ("phoneNumberId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_05ef91cbb7472194fbdc42b560" ON "phone_messages" ("phoneNumberId", "occurredAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a1ce15f3420232b32ede42fdcc" ON "recruiting_applications" ("companyId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_c45581301c84a8b96f4f5174cc" ON "contacts" ("companyId", "lastActivityAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5537f603bea9afe80ae9fba7c" ON "signature_envelopes" ("companyId", "status", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bb6566684b7205f61bf30e5d1f" ON "signature_envelopes" ("companyId", "customerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_eeef4a3165dc6b0548253c3e9a" ON "pipeline_runs" ("pipelineId", "startedAt") `);
    }

}
