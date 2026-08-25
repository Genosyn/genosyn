import { MigrationInterface, QueryRunner } from "typeorm";

export class ChatWorkloadLeaseScope1787667794582 implements MigrationInterface {
    name = 'ChatWorkloadLeaseScope1787667794582'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_777e76e3d7ebbeec8617ea15ba"`);
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`DROP INDEX "IDX_e527e54bbcbbad3c7a2dac6153"`);
        await queryRunner.query(`CREATE TABLE "temporary_workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "employeeId" varchar, "ownerKey" varchar, "scopeKey" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_workload_leases"("id", "companyId", "kind", "expiresAt", "createdAt", "employeeId", "ownerKey") SELECT "id", "companyId", "kind", "expiresAt", "createdAt", "employeeId", "ownerKey" FROM "workload_leases"`);
        await queryRunner.query(`DROP TABLE "workload_leases"`);
        await queryRunner.query(`ALTER TABLE "temporary_workload_leases" RENAME TO "workload_leases"`);
        await queryRunner.query(`CREATE INDEX "IDX_777e76e3d7ebbeec8617ea15ba" ON "workload_leases" ("ownerKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_e527e54bbcbbad3c7a2dac6153" ON "workload_leases" ("employeeId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_0d42db6234525bb0da833e1954" ON "workload_leases" ("employeeId", "kind", "scopeKey") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0d42db6234525bb0da833e1954"`);
        await queryRunner.query(`DROP INDEX "IDX_e527e54bbcbbad3c7a2dac6153"`);
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`DROP INDEX "IDX_777e76e3d7ebbeec8617ea15ba"`);
        await queryRunner.query(`ALTER TABLE "workload_leases" RENAME TO "temporary_workload_leases"`);
        await queryRunner.query(`CREATE TABLE "workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "employeeId" varchar, "ownerKey" varchar)`);
        await queryRunner.query(`INSERT INTO "workload_leases"("id", "companyId", "kind", "expiresAt", "createdAt", "employeeId", "ownerKey") SELECT "id", "companyId", "kind", "expiresAt", "createdAt", "employeeId", "ownerKey" FROM "temporary_workload_leases"`);
        await queryRunner.query(`DROP TABLE "temporary_workload_leases"`);
        await queryRunner.query(`CREATE INDEX "IDX_e527e54bbcbbad3c7a2dac6153" ON "workload_leases" ("employeeId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_777e76e3d7ebbeec8617ea15ba" ON "workload_leases" ("ownerKey") `);
    }

}
