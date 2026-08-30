import { MigrationInterface, QueryRunner } from "typeorm";

export class EvidenceAndTheStop1788091511452 implements MigrationInterface {
    name = 'EvidenceAndTheStop1788091511452'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "routine_checks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "routineId" character varying NOT NULL, "name" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'effect', "spec" text NOT NULL DEFAULT '', "required" boolean NOT NULL DEFAULT true, "enabled" boolean NOT NULL DEFAULT true, "timeoutSec" integer NOT NULL DEFAULT '120', "position" integer NOT NULL DEFAULT '0', "createdById" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f806260ecb71671cbc539296a61" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cf6c878157e725522dcc98950b" ON "routine_checks" ("routineId", "position") `);
        await queryRunner.query(`CREATE TABLE "run_check_results" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "runId" character varying NOT NULL, "checkId" character varying, "name" character varying NOT NULL, "kind" character varying NOT NULL DEFAULT 'effect', "required" boolean NOT NULL DEFAULT true, "passed" boolean NOT NULL DEFAULT false, "exitCode" integer, "detail" text NOT NULL DEFAULT '', "durationMs" integer NOT NULL DEFAULT '0', "attempt" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_70390cd22ad42281e2e8f0e0635" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2613af567a892d15fe9e3a9173" ON "run_check_results" ("runId", "attempt") `);
        await queryRunner.query(`CREATE TABLE "standdowns" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "scope" character varying NOT NULL DEFAULT 'company', "scopeId" character varying, "reason" text NOT NULL DEFAULT '', "source" character varying NOT NULL DEFAULT 'human', "placedByUserId" character varying, "placedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "liftedAt" TIMESTAMP WITH TIME ZONE, "liftedByUserId" character varying, "liftedReason" text NOT NULL DEFAULT '', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_6948bf914162f1056017cab789e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_77b0941634c75b64d5ee5cdc24" ON "standdowns" ("companyId", "liftedAt") `);
        await queryRunner.query(`ALTER TABLE "routines" ADD "consecutiveFailures" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "outcomeCheckedAt" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "checksVerdict" character varying`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "checkRemediations" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "audit_events" ADD "runId" character varying`);
        await queryRunner.query(`ALTER TABLE "audit_events" ADD "conversationId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_dade7093e74d6b81a4502e1529" ON "audit_events" ("companyId", "actorEmployeeId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5bc0eca9bf57d34cedb219ac6a" ON "audit_events" ("runId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5bc0eca9bf57d34cedb219ac6a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dade7093e74d6b81a4502e1529"`);
        await queryRunner.query(`ALTER TABLE "audit_events" DROP COLUMN "conversationId"`);
        await queryRunner.query(`ALTER TABLE "audit_events" DROP COLUMN "runId"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "checkRemediations"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "checksVerdict"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "outcomeCheckedAt"`);
        await queryRunner.query(`ALTER TABLE "routines" DROP COLUMN "consecutiveFailures"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77b0941634c75b64d5ee5cdc24"`);
        await queryRunner.query(`DROP TABLE "standdowns"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2613af567a892d15fe9e3a9173"`);
        await queryRunner.query(`DROP TABLE "run_check_results"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cf6c878157e725522dcc98950b"`);
        await queryRunner.query(`DROP TABLE "routine_checks"`);
    }

}
