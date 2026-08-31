import { MigrationInterface, QueryRunner } from "typeorm";

export class VaultSources1788167628340 implements MigrationInterface {
    name = 'VaultSources1788167628340'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vault_sources" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'bitwarden', "label" character varying NOT NULL, "serverUrl" character varying NOT NULL, "accountHint" character varying NOT NULL DEFAULT '', "encryptedConfig" text NOT NULL, "scopeName" character varying NOT NULL DEFAULT '', "defaultVisibility" character varying NOT NULL DEFAULT 'restricted', "status" character varying NOT NULL DEFAULT 'connected', "statusMessage" character varying NOT NULL DEFAULT '', "lastSyncedAt" TIMESTAMP WITH TIME ZONE, "lastSyncItemCount" integer NOT NULL DEFAULT '0', "createdByUserId" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_698990870b0004887944977fc2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9cb8d68e26c9239ee4b752a063" ON "vault_sources" ("companyId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_7838e6046c1268530ad22e85f1" ON "vault_sources" ("companyId") `);
        await queryRunner.query(`ALTER TABLE "vault_items" ADD "vaultSourceId" character varying`);
        await queryRunner.query(`ALTER TABLE "vault_items" ADD "externalItemId" character varying`);
        await queryRunner.query(`ALTER TABLE "vault_items" ADD "externalRevision" character varying NOT NULL DEFAULT ''`);
        await queryRunner.query(`ALTER TABLE "vault_items" ADD "externalHasTotp" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_385faa73c22431dea12d12c85a" ON "vault_items" ("vaultSourceId", "externalItemId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3a3d65fba89d4dbde305f623d0" ON "vault_items" ("companyId", "vaultSourceId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_3a3d65fba89d4dbde305f623d0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_385faa73c22431dea12d12c85a"`);
        await queryRunner.query(`ALTER TABLE "vault_items" DROP COLUMN "externalHasTotp"`);
        await queryRunner.query(`ALTER TABLE "vault_items" DROP COLUMN "externalRevision"`);
        await queryRunner.query(`ALTER TABLE "vault_items" DROP COLUMN "externalItemId"`);
        await queryRunner.query(`ALTER TABLE "vault_items" DROP COLUMN "vaultSourceId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7838e6046c1268530ad22e85f1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9cb8d68e26c9239ee4b752a063"`);
        await queryRunner.query(`DROP TABLE "vault_sources"`);
    }

}
