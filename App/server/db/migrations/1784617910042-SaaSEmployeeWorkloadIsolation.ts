import { MigrationInterface, QueryRunner } from "typeorm";

export class SaaSEmployeeWorkloadIsolation1784617910042 implements MigrationInterface {
    name = "SaaSEmployeeWorkloadIsolation1784617910042";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`CREATE TABLE "temporary_workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "employeeId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_workload_leases"("id", "companyId", "kind", "expiresAt", "createdAt") SELECT "id", "companyId", "kind", "expiresAt", "createdAt" FROM "workload_leases"`);
        await queryRunner.query(`DROP TABLE "workload_leases"`);
        await queryRunner.query(`ALTER TABLE "temporary_workload_leases" RENAME TO "workload_leases"`);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_e527e54bbcbbad3c7a2dac6153" ON "workload_leases" ("employeeId", "expiresAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_e527e54bbcbbad3c7a2dac6153"`);
        await queryRunner.query(`DROP INDEX "IDX_13de18e33dd4f4936c512a6e1f"`);
        await queryRunner.query(`ALTER TABLE "workload_leases" RENAME TO "temporary_workload_leases"`);
        await queryRunner.query(`CREATE TABLE "workload_leases" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL, "expiresAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "workload_leases"("id", "companyId", "kind", "expiresAt", "createdAt") SELECT "id", "companyId", "kind", "expiresAt", "createdAt" FROM "temporary_workload_leases"`);
        await queryRunner.query(`DROP TABLE "temporary_workload_leases"`);
        await queryRunner.query(`CREATE INDEX "IDX_13de18e33dd4f4936c512a6e1f" ON "workload_leases" ("companyId", "expiresAt") `);
    }
}
