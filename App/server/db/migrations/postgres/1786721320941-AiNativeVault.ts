import { MigrationInterface, QueryRunner } from "typeorm";

export class AiNativeVault1786721320941 implements MigrationInterface {
    name = 'AiNativeVault1786721320941'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vault_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "type" character varying NOT NULL, "visibility" character varying NOT NULL DEFAULT 'restricted', "encryptedPayload" text NOT NULL, "version" integer NOT NULL DEFAULT '1', "createdByUserId" character varying, "createdByEmployeeId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5f8f06333e32f168cfce6f3158f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_10abe72928ce7c8dcf8c6d817e" ON "vault_items" ("createdByEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6b2875632821cccefb74a15fea" ON "vault_items" ("createdByUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d16cff0c51777d2d3dfd489952" ON "vault_items" ("companyId", "visibility") `);
        await queryRunner.query(`CREATE TABLE "vault_item_member_access" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "vaultItemId" character varying NOT NULL, "userId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'view', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_35fb42b3a2eed08842862015a53" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_eb7e484e7a153624e7f84eda04" ON "vault_item_member_access" ("vaultItemId", "userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d675558fd6d68b517c6159a909" ON "vault_item_member_access" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_9a67483e913872a31e335c6339" ON "vault_item_member_access" ("companyId") `);
        await queryRunner.query(`CREATE TABLE "employee_vault_grants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "vaultItemId" character varying NOT NULL, "employeeId" character varying NOT NULL, "accessLevel" character varying NOT NULL DEFAULT 'use', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ede338b527fc279e5b3b3f596a2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_dfebd881ae0a6cd985a8bea9cb" ON "employee_vault_grants" ("vaultItemId", "employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_e461de7b978d8cb7e39e5f623f" ON "employee_vault_grants" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_40a316c0e994cec7a1934e9f18" ON "employee_vault_grants" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_40a316c0e994cec7a1934e9f18"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_e461de7b978d8cb7e39e5f623f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dfebd881ae0a6cd985a8bea9cb"`);
        await queryRunner.query(`DROP TABLE "employee_vault_grants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9a67483e913872a31e335c6339"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d675558fd6d68b517c6159a909"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eb7e484e7a153624e7f84eda04"`);
        await queryRunner.query(`DROP TABLE "vault_item_member_access"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d16cff0c51777d2d3dfd489952"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6b2875632821cccefb74a15fea"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_10abe72928ce7c8dcf8c6d817e"`);
        await queryRunner.query(`DROP TABLE "vault_items"`);
    }

}
