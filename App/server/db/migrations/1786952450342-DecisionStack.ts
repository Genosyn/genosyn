import { MigrationInterface, QueryRunner } from "typeorm";

export class DecisionStack1786952450342 implements MigrationInterface {
    name = 'DecisionStack1786952450342'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "decisions" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "employeeId" varchar NOT NULL, "routineId" varchar, "runId" varchar, "conversationId" varchar, "title" varchar NOT NULL, "body" text NOT NULL DEFAULT (''), "optionsJson" text NOT NULL, "status" varchar NOT NULL DEFAULT ('pending'), "urgency" varchar NOT NULL DEFAULT ('normal'), "assigneeUserId" varchar, "chosenOptionId" varchar, "chosenOptionLabel" varchar, "note" text, "decidedByUserId" varchar, "decidedAt" datetime, "expiresAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f3a3267c40488e19bf80d79b33" ON "decisions" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d1f21802ddf797a495d484f640" ON "decisions" ("employeeId") `);
        await queryRunner.query(`CREATE INDEX "IDX_ad199fe6f4f207d0ec75199d39" ON "decisions" ("companyId", "status") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_ad199fe6f4f207d0ec75199d39"`);
        await queryRunner.query(`DROP INDEX "IDX_d1f21802ddf797a495d484f640"`);
        await queryRunner.query(`DROP INDEX "IDX_f3a3267c40488e19bf80d79b33"`);
        await queryRunner.query(`DROP TABLE "decisions"`);
    }

}
