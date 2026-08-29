import { MigrationInterface, QueryRunner } from "typeorm";

export class CompanySsoAllowedDomains1787997824683 implements MigrationInterface {
    name = 'CompanySsoAllowedDomains1787997824683'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d7c2cada13a62bd3e696d09574"`);
        await queryRunner.query(`CREATE TABLE "temporary_company_sso" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "provider" varchar NOT NULL DEFAULT ('google'), "displayName" varchar NOT NULL DEFAULT (''), "issuer" varchar NOT NULL DEFAULT (''), "clientId" varchar NOT NULL DEFAULT (''), "encryptedClientSecret" varchar NOT NULL DEFAULT (''), "autoJoin" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "allowedEmailDomains" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_company_sso"("id", "companyId", "enabled", "provider", "displayName", "issuer", "clientId", "encryptedClientSecret", "autoJoin", "createdAt", "updatedAt") SELECT "id", "companyId", "enabled", "provider", "displayName", "issuer", "clientId", "encryptedClientSecret", "autoJoin", "createdAt", "updatedAt" FROM "company_sso"`);
        await queryRunner.query(`DROP TABLE "company_sso"`);
        await queryRunner.query(`ALTER TABLE "temporary_company_sso" RENAME TO "company_sso"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d7c2cada13a62bd3e696d09574" ON "company_sso" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_d7c2cada13a62bd3e696d09574"`);
        await queryRunner.query(`ALTER TABLE "company_sso" RENAME TO "temporary_company_sso"`);
        await queryRunner.query(`CREATE TABLE "company_sso" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "provider" varchar NOT NULL DEFAULT ('google'), "displayName" varchar NOT NULL DEFAULT (''), "issuer" varchar NOT NULL DEFAULT (''), "clientId" varchar NOT NULL DEFAULT (''), "encryptedClientSecret" varchar NOT NULL DEFAULT (''), "autoJoin" boolean NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "company_sso"("id", "companyId", "enabled", "provider", "displayName", "issuer", "clientId", "encryptedClientSecret", "autoJoin", "createdAt", "updatedAt") SELECT "id", "companyId", "enabled", "provider", "displayName", "issuer", "clientId", "encryptedClientSecret", "autoJoin", "createdAt", "updatedAt" FROM "temporary_company_sso"`);
        await queryRunner.query(`DROP TABLE "temporary_company_sso"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_d7c2cada13a62bd3e696d09574" ON "company_sso" ("companyId") `);
    }

}
