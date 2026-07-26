import { MigrationInterface, QueryRunner } from "typeorm";

export class BaseTableArchive1785093331197 implements MigrationInterface {
    name = 'BaseTableArchive1785093331197'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "base_tables" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "base_tables" DROP COLUMN "archivedAt"`);
    }

}
