import { MigrationInterface, QueryRunner } from "typeorm";

export class HotQueryIndexes1791208871662 implements MigrationInterface {
    name = 'HotQueryIndexes1791208871662'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_aaaea7e6127a655d678f23b60f" ON "runs" ("parentRunId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7908524ca9b4e2879d1b96478f" ON "mail_messages" ("accountId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_d3017a0196c3fa8b5f953ea02d" ON "mail_messages" ("accountId", "gmailDraftId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_d3017a0196c3fa8b5f953ea02d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7908524ca9b4e2879d1b96478f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aaaea7e6127a655d678f23b60f"`);
    }

}
