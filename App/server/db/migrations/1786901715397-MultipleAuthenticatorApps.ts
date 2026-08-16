import { MigrationInterface, QueryRunner } from "typeorm";

export class MultipleAuthenticatorApps1786901715397 implements MigrationInterface {
    name = 'MultipleAuthenticatorApps1786901715397'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "totp_credentials" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "name" varchar(100) NOT NULL, "secret" text NOT NULL, "verifiedAt" datetime, "lastUsedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_acc3822c58b7f186d6e18bfbac" ON "totp_credentials" ("userId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_acc3822c58b7f186d6e18bfbac"`);
        await queryRunner.query(`DROP TABLE "totp_credentials"`);
    }

}
