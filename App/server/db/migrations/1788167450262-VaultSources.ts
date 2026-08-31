import { MigrationInterface, QueryRunner } from "typeorm";

export class VaultSources1788167450262 implements MigrationInterface {
    name = 'VaultSources1788167450262'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vault_sources" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "kind" varchar NOT NULL DEFAULT ('bitwarden'), "label" varchar NOT NULL, "serverUrl" varchar NOT NULL, "accountHint" varchar NOT NULL DEFAULT (''), "encryptedConfig" text NOT NULL, "scopeName" varchar NOT NULL DEFAULT (''), "defaultVisibility" varchar NOT NULL DEFAULT ('restricted'), "status" varchar NOT NULL DEFAULT ('connected'), "statusMessage" varchar NOT NULL DEFAULT (''), "lastSyncedAt" datetime, "lastSyncItemCount" integer NOT NULL DEFAULT (0), "createdByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_9cb8d68e26c9239ee4b752a063" ON "vault_sources" ("companyId", "kind") `);
        await queryRunner.query(`CREATE INDEX "IDX_7838e6046c1268530ad22e85f1" ON "vault_sources" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_d16cff0c51777d2d3dfd489952"`);
        await queryRunner.query(`DROP INDEX "IDX_6b2875632821cccefb74a15fea"`);
        await queryRunner.query(`DROP INDEX "IDX_10abe72928ce7c8dcf8c6d817e"`);
        await queryRunner.query(`CREATE TABLE "temporary_vault_items" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "type" varchar NOT NULL, "visibility" varchar NOT NULL DEFAULT ('restricted'), "encryptedPayload" text NOT NULL, "version" integer NOT NULL DEFAULT (1), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "vaultSourceId" varchar, "externalItemId" varchar, "externalRevision" varchar NOT NULL DEFAULT (''), "externalHasTotp" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_vault_items"("id", "companyId", "type", "visibility", "encryptedPayload", "version", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "type", "visibility", "encryptedPayload", "version", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt" FROM "vault_items"`);
        await queryRunner.query(`DROP TABLE "vault_items"`);
        await queryRunner.query(`ALTER TABLE "temporary_vault_items" RENAME TO "vault_items"`);
        await queryRunner.query(`CREATE INDEX "IDX_d16cff0c51777d2d3dfd489952" ON "vault_items" ("companyId", "visibility") `);
        await queryRunner.query(`CREATE INDEX "IDX_6b2875632821cccefb74a15fea" ON "vault_items" ("createdByUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_10abe72928ce7c8dcf8c6d817e" ON "vault_items" ("createdByEmployeeId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_385faa73c22431dea12d12c85a" ON "vault_items" ("vaultSourceId", "externalItemId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3a3d65fba89d4dbde305f623d0" ON "vault_items" ("companyId", "vaultSourceId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_3a3d65fba89d4dbde305f623d0"`);
        await queryRunner.query(`DROP INDEX "IDX_385faa73c22431dea12d12c85a"`);
        await queryRunner.query(`DROP INDEX "IDX_10abe72928ce7c8dcf8c6d817e"`);
        await queryRunner.query(`DROP INDEX "IDX_6b2875632821cccefb74a15fea"`);
        await queryRunner.query(`DROP INDEX "IDX_d16cff0c51777d2d3dfd489952"`);
        await queryRunner.query(`ALTER TABLE "vault_items" RENAME TO "temporary_vault_items"`);
        await queryRunner.query(`CREATE TABLE "vault_items" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "type" varchar NOT NULL, "visibility" varchar NOT NULL DEFAULT ('restricted'), "encryptedPayload" text NOT NULL, "version" integer NOT NULL DEFAULT (1), "createdByUserId" varchar, "createdByEmployeeId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "vault_items"("id", "companyId", "type", "visibility", "encryptedPayload", "version", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt") SELECT "id", "companyId", "type", "visibility", "encryptedPayload", "version", "createdByUserId", "createdByEmployeeId", "createdAt", "updatedAt" FROM "temporary_vault_items"`);
        await queryRunner.query(`DROP TABLE "temporary_vault_items"`);
        await queryRunner.query(`CREATE INDEX "IDX_10abe72928ce7c8dcf8c6d817e" ON "vault_items" ("createdByEmployeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_6b2875632821cccefb74a15fea" ON "vault_items" ("createdByUserId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d16cff0c51777d2d3dfd489952" ON "vault_items" ("companyId", "visibility") `);
        await queryRunner.query(`DROP INDEX "IDX_7838e6046c1268530ad22e85f1"`);
        await queryRunner.query(`DROP INDEX "IDX_9cb8d68e26c9239ee4b752a063"`);
        await queryRunner.query(`DROP TABLE "vault_sources"`);
    }

}
