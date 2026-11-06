import { MigrationInterface, QueryRunner } from "typeorm";

export class InputRequests1793961695491 implements MigrationInterface {
    name = 'InputRequests1793961695491'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "input_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "kind" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'waiting', "workKey" character varying NOT NULL, "runId" character varying, "routineId" character varying, "todoId" character varying, "conversationId" character varying, "browserSessionId" character varying, "vaultItemId" character varying, "assigneeUserId" character varying, "adminOnly" boolean NOT NULL DEFAULT false, "tainted" boolean NOT NULL DEFAULT false, "pageOrigin" character varying NOT NULL DEFAULT '', "askingUntil" TIMESTAMP WITH TIME ZONE, "readyAt" TIMESTAMP WITH TIME ZONE, "readyByUserId" character varying, "answeredAt" TIMESTAMP WITH TIME ZONE, "answeredByUserId" character varying, "attempts" integer NOT NULL DEFAULT '0', "codesGiven" integer NOT NULL DEFAULT '0', "lastCodeRefused" boolean NOT NULL DEFAULT false, "reminders" integer NOT NULL DEFAULT '0', "nextReminderAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "closedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "title" character varying NOT NULL DEFAULT '', "body" text NOT NULL DEFAULT '', "answerText" text, "encryptedAnswer" text, "closeReason" text NOT NULL DEFAULT '', CONSTRAINT "PK_cf758ffe3840e3b9ca37b7e0f5f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2c6664b82fca57fafd9cd3a1d9" ON "input_requests" ("workKey", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_c430cf76c2682858c9034b5c52" ON "input_requests" ("status", "nextReminderAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_ab73604bdd1e84d3347e6709f4" ON "input_requests" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_8e4f69c7177b3097ce49b81a67" ON "input_requests" ("companyId", "status") `);
        await queryRunner.query(`ALTER TABLE "runs" ADD "personPauses" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "runs" ADD "waitingOnInputRequestId" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "waitingOnInputRequestId"`);
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "personPauses"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8e4f69c7177b3097ce49b81a67"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ab73604bdd1e84d3347e6709f4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c430cf76c2682858c9034b5c52"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2c6664b82fca57fafd9cd3a1d9"`);
        await queryRunner.query(`DROP TABLE "input_requests"`);
    }

}
