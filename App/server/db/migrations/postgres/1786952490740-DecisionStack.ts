import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionStack1786952490740 implements MigrationInterface {
    name = 'DecisionStack1786952490740'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "decisions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "companyId" character varying NOT NULL, "employeeId" character varying NOT NULL, "routineId" character varying, "runId" character varying, "conversationId" character varying, "title" character varying NOT NULL, "body" text NOT NULL DEFAULT '', "optionsJson" text NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "urgency" character varying NOT NULL DEFAULT 'normal', "assigneeUserId" character varying, "chosenOptionId" character varying, "chosenOptionLabel" character varying, "note" text, "decidedByUserId" character varying, "decidedAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_48eee6fa229cd5e43648f6a2ec3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f3a3267c40488e19bf80d79b33" ON "decisions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d1f21802ddf797a495d484f640" ON "decisions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ad199fe6f4f207d0ec75199d39" ON "decisions" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_ad199fe6f4f207d0ec75199d39"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d1f21802ddf797a495d484f640"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f3a3267c40488e19bf80d79b33"`);
        await queryRunner.query(`DROP TABLE "decisions"`);
    }

}
