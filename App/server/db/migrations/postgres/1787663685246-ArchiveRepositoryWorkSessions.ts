import { MigrationInterface, QueryRunner } from "typeorm";

export class ArchiveRepositoryWorkSessions1787663685246 implements MigrationInterface {
    name = 'ArchiveRepositoryWorkSessions1787663685246'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" ADD "archivedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "repository_work_sessions" DROP COLUMN "archivedAt"`);
    }

}
