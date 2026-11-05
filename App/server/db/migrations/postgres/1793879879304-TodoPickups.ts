import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoPickups1793879879304 implements MigrationInterface {
    name = 'TodoPickups1793879879304'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "todo_pickups" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "todoId" character varying NOT NULL, "employeeId" character varying NOT NULL, "trigger" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'queued', "hold" character varying, "authority" character varying NOT NULL DEFAULT 'employee', "requesterUserId" character varying, "requesterSessionVersion" integer, "startedByMember" boolean NOT NULL DEFAULT false, "mailDeliveryMode" character varying, "proactiveReview" boolean NOT NULL DEFAULT false, "tainted" boolean NOT NULL DEFAULT false, "mailThreadId" character varying, "note" text NOT NULL DEFAULT '', "rerunJson" text, "priorStatus" character varying, "notBeforeAt" TIMESTAMP WITH TIME ZONE, "workerId" character varying, "leaseExpiresAt" TIMESTAMP WITH TIME ZONE, "attempt" integer NOT NULL DEFAULT '0', "failures" integer NOT NULL DEFAULT '0', "acceptedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "endedAt" TIMESTAMP WITH TIME ZONE, "stoppedByUserId" character varying, "errorMessage" text NOT NULL DEFAULT '', "replyText" text NOT NULL DEFAULT '', "activityJson" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f33d121d125301460f79f855cd8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d660c1a79309e10a68636f3616" ON "todo_pickups" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_12779fbbd68b3999e2ddc73c84" ON "todo_pickups" ("todoId") WHERE "status" IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_d48fbd2a266b9b270989d8d445" ON "todo_pickups" ("todoId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_057cfd33f8f915fc96c39dcc9f" ON "todo_pickups" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_195e91587b7279fa9074d1d972" ON "todo_pickups" ("status", "notBeforeAt") `);
        await queryRunner.query(`ALTER TABLE "todos" ADD "untrustedText" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "tainted" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "todos" ADD "aiChainDepth" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "todo_comments" ADD "pickupId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "todo_comments" DROP COLUMN "pickupId"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "aiChainDepth"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "tainted"`);
        await queryRunner.query(`ALTER TABLE "todos" DROP COLUMN "untrustedText"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_195e91587b7279fa9074d1d972"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_057cfd33f8f915fc96c39dcc9f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d48fbd2a266b9b270989d8d445"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_12779fbbd68b3999e2ddc73c84"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d660c1a79309e10a68636f3616"`);
        await queryRunner.query(`DROP TABLE "todo_pickups"`);
    }

}
