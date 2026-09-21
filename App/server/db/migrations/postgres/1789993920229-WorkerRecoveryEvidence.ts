import { MigrationInterface, QueryRunner } from "typeorm";

export class WorkerRecoveryEvidence1789993920229 implements MigrationInterface {
    name = 'WorkerRecoveryEvidence1789993920229'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "parallel_worker_results" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "scopeKey" character varying NOT NULL, "authority" character varying NOT NULL, "requesterUserId" character varying NOT NULL DEFAULT '', "parentRunId" character varying, "parentTurnId" character varying NOT NULL, "briefHash" character varying NOT NULL, "label" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "output" text NOT NULL DEFAULT '', "totalChars" integer NOT NULL DEFAULT '0', "grantsJson" text NOT NULL, "requiredToolsJson" text NOT NULL DEFAULT '[]', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_360fcd767161f633b1ad71802cd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7175f86e50b8dc2a8f93ae47fa" ON "parallel_worker_results" ("companyId", "employeeId", "scopeKey", "authority", "requesterUserId", "briefHash") `);
        await queryRunner.query(`CREATE INDEX "IDX_0fae31c0ac461cbda133033210" ON "parallel_worker_results" ("companyId", "employeeId", "scopeKey", "authority", "requesterUserId") `);
        await queryRunner.query(`ALTER TABLE "runs" ADD "diagnosticsJson" text`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "requiredToolsJson" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "requiredToolsJson"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "diagnosticsJson"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0fae31c0ac461cbda133033210"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7175f86e50b8dc2a8f93ae47fa"`);
        await queryRunner.query(`DROP TABLE "parallel_worker_results"`);
    }

}
