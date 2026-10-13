import { MigrationInterface, QueryRunner } from "typeorm";

export class AuditRecordHistoryIndex1791895737318 implements MigrationInterface {
    name = 'AuditRecordHistoryIndex1791895737318'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_d4ea3252117b25a6bc8e44759f" ON "audit_events" ("companyId", "targetType", "targetId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_d4ea3252117b25a6bc8e44759f"`);
    }

}
