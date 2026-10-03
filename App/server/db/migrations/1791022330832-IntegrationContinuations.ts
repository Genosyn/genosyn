import { MigrationInterface, QueryRunner } from "typeorm";

export class IntegrationContinuations1791022330832 implements MigrationInterface {
    name = 'IntegrationContinuations1791022330832'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "integration_continuations" ("id" varchar PRIMARY KEY NOT NULL, "connectionId" varchar NOT NULL, "token" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_771193eb8a92b8b8d2ebba5e1f" ON "integration_continuations" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c914c1f0537c057ca22c056178" ON "integration_continuations" ("createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_c914c1f0537c057ca22c056178"`);
        await queryRunner.query(`DROP INDEX "IDX_771193eb8a92b8b8d2ebba5e1f"`);
        await queryRunner.query(`DROP TABLE "integration_continuations"`);
    }

}
