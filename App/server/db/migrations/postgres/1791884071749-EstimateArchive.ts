import { MigrationInterface, QueryRunner } from "typeorm";

export class EstimateArchive1791884071749 implements MigrationInterface {
    name = 'EstimateArchive1791884071749'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "estimates" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "IDX_a94ef2010066bdd4de59c22062" ON "estimates" ("companyId", "archivedAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a94ef2010066bdd4de59c22062"`);
        await queryRunner.query(`ALTER TABLE "estimates" DROP COLUMN "archivedAt"`);
    }

}
