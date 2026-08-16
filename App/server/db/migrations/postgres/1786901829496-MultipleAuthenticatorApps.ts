import { MigrationInterface, QueryRunner } from "typeorm";

export class MultipleAuthenticatorApps1786901829496 implements MigrationInterface {
    name = 'MultipleAuthenticatorApps1786901829496'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "totp_credentials" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" character varying NOT NULL, "name" character varying(100) NOT NULL, "secret" text NOT NULL, "verifiedAt" TIMESTAMP WITH TIME ZONE, "lastUsedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_48831fcc514f614444afa41742e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_acc3822c58b7f186d6e18bfbac" ON "totp_credentials" ("userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_acc3822c58b7f186d6e18bfbac"`);
        await queryRunner.query(`DROP TABLE "totp_credentials"`);
    }

}
