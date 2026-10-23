import { MigrationInterface, QueryRunner } from "typeorm";

export class BackupCopies1792757793385 implements MigrationInterface {
    name = 'BackupCopies1792757793385'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "backup_copies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "backupId" character varying NOT NULL, "destinationId" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "error" text NOT NULL DEFAULT '', "startedAt" TIMESTAMP WITH TIME ZONE, "copiedAt" TIMESTAMP WITH TIME ZONE, "checkedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ac331b82a019d4d2eb4325ce0ce" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6a54a7d288aef93a0b7f522128" ON "backup_copies" ("destinationId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a02e83c263fad1b62b1f70db34" ON "backup_copies" ("backupId", "destinationId") `);
        await queryRunner.query(`ALTER TABLE "backups" ADD "copiesTracked" boolean NOT NULL DEFAULT false`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "backups" DROP COLUMN "copiesTracked"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a02e83c263fad1b62b1f70db34"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_6a54a7d288aef93a0b7f522128"`);
        await queryRunner.query(`DROP TABLE "backup_copies"`);
    }

}
