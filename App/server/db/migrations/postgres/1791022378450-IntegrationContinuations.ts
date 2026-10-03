import { MigrationInterface, QueryRunner } from "typeorm";

export class IntegrationContinuations1791022378450 implements MigrationInterface {
    name = 'IntegrationContinuations1791022378450'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "integration_continuations" ("id" character varying NOT NULL, "connectionId" character varying NOT NULL, "token" text NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c3f1a31481018335faaa0948e93" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_771193eb8a92b8b8d2ebba5e1f" ON "integration_continuations" ("connectionId") `);
        await queryRunner.query(`CREATE INDEX "IDX_c914c1f0537c057ca22c056178" ON "integration_continuations" ("createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c914c1f0537c057ca22c056178"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_771193eb8a92b8b8d2ebba5e1f"`);
        await queryRunner.query(`DROP TABLE "integration_continuations"`);
    }

}
