import { MigrationInterface, QueryRunner } from "typeorm";

export class ConnectedApps1792820608277 implements MigrationInterface {
    name = 'ConnectedApps1792820608277'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "oauth_clients" ("id" varchar PRIMARY KEY NOT NULL, "clientId" varchar(64) NOT NULL, "clientSecretHash" varchar(64), "tokenEndpointAuthMethod" varchar NOT NULL DEFAULT ('none'), "name" varchar NOT NULL, "clientUri" varchar, "redirectUrisJson" text NOT NULL, "lastUsedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b0c094fe1ef0a6c4af8f2b10be" ON "oauth_clients" ("clientId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d342c613024ddf36804ea7396" ON "oauth_clients" ("createdAt") `);
        await queryRunner.query(`CREATE TABLE "connected_apps" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "userId" varchar NOT NULL, "oauthClientId" varchar NOT NULL, "name" varchar NOT NULL, "redirectUri" text NOT NULL, "scope" varchar NOT NULL, "resource" text NOT NULL, "lastUsedAt" datetime, "expiresAt" datetime NOT NULL, "revokedAt" datetime, "revokedReason" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_5fbebae5e93462c7351abc09f3" ON "connected_apps" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0817b5640c65f8c7243a35e6fa" ON "connected_apps" ("oauthClientId") `);
        await queryRunner.query(`CREATE INDEX "IDX_92f1241a0302b420928228fc94" ON "connected_apps" ("companyId", "userId") `);
        await queryRunner.query(`CREATE TABLE "connected_app_tokens" ("id" varchar PRIMARY KEY NOT NULL, "connectedAppId" varchar NOT NULL, "kind" varchar NOT NULL, "tokenHash" varchar(64) NOT NULL, "expiresAt" datetime NOT NULL, "usedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_57294e68a0eb1faa9c19b0ec0b" ON "connected_app_tokens" ("connectedAppId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_75cb22b903197c6e74e6456690" ON "connected_app_tokens" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_0b3c32c75d29f18df83f91c69b" ON "connected_app_tokens" ("expiresAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0b3c32c75d29f18df83f91c69b"`);
        await queryRunner.query(`DROP INDEX "IDX_75cb22b903197c6e74e6456690"`);
        await queryRunner.query(`DROP INDEX "IDX_57294e68a0eb1faa9c19b0ec0b"`);
        await queryRunner.query(`DROP TABLE "connected_app_tokens"`);
        await queryRunner.query(`DROP INDEX "IDX_92f1241a0302b420928228fc94"`);
        await queryRunner.query(`DROP INDEX "IDX_0817b5640c65f8c7243a35e6fa"`);
        await queryRunner.query(`DROP INDEX "IDX_5fbebae5e93462c7351abc09f3"`);
        await queryRunner.query(`DROP TABLE "connected_apps"`);
        await queryRunner.query(`DROP INDEX "IDX_8d342c613024ddf36804ea7396"`);
        await queryRunner.query(`DROP INDEX "IDX_b0c094fe1ef0a6c4af8f2b10be"`);
        await queryRunner.query(`DROP TABLE "oauth_clients"`);
    }

}
