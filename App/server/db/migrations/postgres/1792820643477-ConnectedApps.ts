import { MigrationInterface, QueryRunner } from "typeorm";

export class ConnectedApps1792820643477 implements MigrationInterface {
    name = 'ConnectedApps1792820643477'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "oauth_clients" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "clientId" character varying(64) NOT NULL, "clientSecretHash" character varying(64), "tokenEndpointAuthMethod" character varying NOT NULL DEFAULT 'none', "name" character varying NOT NULL, "clientUri" character varying, "redirectUrisJson" text NOT NULL, "lastUsedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c4759172d3431bae6f04e678e0d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_b0c094fe1ef0a6c4af8f2b10be" ON "oauth_clients" ("clientId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8d342c613024ddf36804ea7396" ON "oauth_clients" ("createdAt") `);
        await queryRunner.query(`CREATE TABLE "connected_apps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "userId" character varying NOT NULL, "oauthClientId" character varying NOT NULL, "name" character varying NOT NULL, "redirectUri" text NOT NULL, "scope" character varying NOT NULL, "resource" text NOT NULL, "lastUsedAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE, "revokedReason" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1198e2f70d9af54672b48b0fdf4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5fbebae5e93462c7351abc09f3" ON "connected_apps" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0817b5640c65f8c7243a35e6fa" ON "connected_apps" ("oauthClientId") `);
        await queryRunner.query(`CREATE INDEX "IDX_92f1241a0302b420928228fc94" ON "connected_apps" ("companyId", "userId") `);
        await queryRunner.query(`CREATE TABLE "connected_app_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "connectedAppId" character varying NOT NULL, "kind" character varying NOT NULL, "tokenHash" character varying(64) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "usedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_233e41e219e8c332526126d075b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_57294e68a0eb1faa9c19b0ec0b" ON "connected_app_tokens" ("connectedAppId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_75cb22b903197c6e74e6456690" ON "connected_app_tokens" ("tokenHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_0b3c32c75d29f18df83f91c69b" ON "connected_app_tokens" ("expiresAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_0b3c32c75d29f18df83f91c69b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_75cb22b903197c6e74e6456690"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_57294e68a0eb1faa9c19b0ec0b"`);
        await queryRunner.query(`DROP TABLE "connected_app_tokens"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_92f1241a0302b420928228fc94"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0817b5640c65f8c7243a35e6fa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5fbebae5e93462c7351abc09f3"`);
        await queryRunner.query(`DROP TABLE "connected_apps"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8d342c613024ddf36804ea7396"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b0c094fe1ef0a6c4af8f2b10be"`);
        await queryRunner.query(`DROP TABLE "oauth_clients"`);
    }

}
