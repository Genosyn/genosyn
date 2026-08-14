import { MigrationInterface, QueryRunner } from "typeorm";

export class AiNativeVault1786721255451 implements MigrationInterface {
    name = 'AiNativeVault1786721255451'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vault_items" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "type" varchar NOT NULL, "visibility" varchar NOT NULL DEFAULT ('restricted'), "encryptedPayload" text NOT NULL, "version" integer NOT NULL DEFAULT (1), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_10abe72928ce7c8dcf8c6d817e" ON "vault_items" ("createdByEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6b2875632821cccefb74a15fea" ON "vault_items" ("createdByUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d16cff0c51777d2d3dfd489952" ON "vault_items" ("companyId", "visibility") `);
        await queryRunner.query(`CREATE TABLE "vault_item_member_access" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "vaultItemId" varchar NOT NULL, "userId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('view'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_eb7e484e7a153624e7f84eda04" ON "vault_item_member_access" ("vaultItemId", "userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d675558fd6d68b517c6159a909" ON "vault_item_member_access" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a67483e913872a31e335c6339" ON "vault_item_member_access" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "employee_vault_grants" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "vaultItemId" varchar NOT NULL, "employeeId" varchar NOT NULL, "accessLevel" varchar NOT NULL DEFAULT ('use'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dfebd881ae0a6cd985a8bea9cb" ON "employee_vault_grants" ("vaultItemId", "employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e461de7b978d8cb7e39e5f623f" ON "employee_vault_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_40a316c0e994cec7a1934e9f18" ON "employee_vault_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_40a316c0e994cec7a1934e9f18"`);
        await queryRunner.query(`DROP INDEX "IDX_e461de7b978d8cb7e39e5f623f"`);
        await queryRunner.query(`DROP INDEX "IDX_dfebd881ae0a6cd985a8bea9cb"`);
        await queryRunner.query(`DROP TABLE "employee_vault_grants"`);
        await queryRunner.query(`DROP INDEX "IDX_9a67483e913872a31e335c6339"`);
        await queryRunner.query(`DROP INDEX "IDX_d675558fd6d68b517c6159a909"`);
        await queryRunner.query(`DROP INDEX "IDX_eb7e484e7a153624e7f84eda04"`);
        await queryRunner.query(`DROP TABLE "vault_item_member_access"`);
        await queryRunner.query(`DROP INDEX "IDX_d16cff0c51777d2d3dfd489952"`);
        await queryRunner.query(`DROP INDEX "IDX_6b2875632821cccefb74a15fea"`);
        await queryRunner.query(`DROP INDEX "IDX_10abe72928ce7c8dcf8c6d817e"`);
        await queryRunner.query(`DROP TABLE "vault_items"`);
    }

}
