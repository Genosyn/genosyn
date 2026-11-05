import { MigrationInterface, QueryRunner } from "typeorm";

export class HelpCenter1793898281105 implements MigrationInterface {
    name = 'HelpCenter1793898281105'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "support_settings" ADD "helpCenterEnabled" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE INDEX "IDX_35525ac07b62f428da567ceaae" ON "support_articles" ("companyId", "status", "title", "id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_35525ac07b62f428da567ceaae"`);
        await queryRunner.query(`ALTER TABLE "support_settings" DROP COLUMN "helpCenterEnabled"`);
    }

}
