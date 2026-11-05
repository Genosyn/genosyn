import { MigrationInterface, QueryRunner } from "typeorm";

export class ProjectIntake1793883722455 implements MigrationInterface {
    name = 'ProjectIntake1793883722455'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "project_intakes" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "projectId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "whatBelongs" text NOT NULL DEFAULT (''), "instruction" text NOT NULL DEFAULT (''), "accountIdsJson" text NOT NULL DEFAULT ('[]'), "assigneeEmployeeId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar, "replyMode" varchar NOT NULL DEFAULT ('review'), "trustedSenders" text NOT NULL DEFAULT (''), "updatedByUserId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_f3011d35e8f3d4dda6cc9a9884" ON "project_intakes" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6bf941dbb94d502a146ea1bf7f" ON "project_intakes" ("projectId") `);
        await queryRunner.query(`DROP INDEX "IDX_195e91587b7279fa9074d1d972"`);
        await queryRunner.query(`DROP INDEX "IDX_057cfd33f8f915fc96c39dcc9f"`);
        await queryRunner.query(`DROP INDEX "IDX_d48fbd2a266b9b270989d8d445"`);
        await queryRunner.query(`DROP INDEX "IDX_12779fbbd68b3999e2ddc73c84"`);
        await queryRunner.query(`DROP INDEX "IDX_d660c1a79309e10a68636f3616"`);
        await queryRunner.query(`CREATE TABLE "temporary_todo_pickups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "todoId" varchar NOT NULL, "employeeId" varchar NOT NULL, "trigger" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "hold" varchar, "authority" varchar NOT NULL DEFAULT ('employee'), "requesterUserId" varchar, "requesterSessionVersion" integer, "startedByMember" boolean NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "proactiveReview" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "mailThreadId" varchar, "note" text NOT NULL DEFAULT (''), "rerunJson" text, "priorStatus" varchar, "notBeforeAt" datetime, "workerId" varchar, "leaseExpiresAt" datetime, "attempt" integer NOT NULL DEFAULT (0), "failures" integer NOT NULL DEFAULT (0), "acceptedAt" datetime NOT NULL, "endedAt" datetime, "stoppedByUserId" varchar, "errorMessage" text NOT NULL DEFAULT (''), "replyText" text NOT NULL DEFAULT (''), "activityJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "trustedSender" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_todo_pickups"("id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt") SELECT "id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt" FROM "todo_pickups"`);
        await queryRunner.query(`DROP TABLE "todo_pickups"`);
        await queryRunner.query(`ALTER TABLE "temporary_todo_pickups" RENAME TO "todo_pickups"`);
        await queryRunner.query(`CREATE INDEX "IDX_195e91587b7279fa9074d1d972" ON "todo_pickups" ("status", "notBeforeAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_057cfd33f8f915fc96c39dcc9f" ON "todo_pickups" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_d48fbd2a266b9b270989d8d445" ON "todo_pickups" ("todoId", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_12779fbbd68b3999e2ddc73c84" ON "todo_pickups" ("todoId") WHERE "status" IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_d660c1a79309e10a68636f3616" ON "todo_pickups" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_282e4280bb27e3440baae62d4b"`);
        await queryRunner.query(`DROP INDEX "IDX_064226a7f1303b8f8e4ffb47fa"`);
        await queryRunner.query(`DROP INDEX "IDX_7c1c48e89e0b83b24910a71d42"`);
        await queryRunner.query(`DROP INDEX "IDX_adbb2d33d5d7b3c5833876fa5b"`);
        await queryRunner.query(`CREATE TABLE "temporary_mail_inbound_analyses" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "messageId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "employeeId" varchar, "modelId" varchar, "category" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "actionsJson" text NOT NULL DEFAULT ('[]'), "errorMessage" text NOT NULL DEFAULT (''), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "autoActionsJson" text NOT NULL DEFAULT ('[]'), "intakeJson" text NOT NULL DEFAULT (''))`);
        await queryRunner.query(`INSERT INTO "temporary_mail_inbound_analyses"("id", "companyId", "accountId", "threadId", "messageId", "status", "employeeId", "modelId", "category", "summary", "actionsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt", "autoActionsJson") SELECT "id", "companyId", "accountId", "threadId", "messageId", "status", "employeeId", "modelId", "category", "summary", "actionsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt", "autoActionsJson" FROM "mail_inbound_analyses"`);
        await queryRunner.query(`DROP TABLE "mail_inbound_analyses"`);
        await queryRunner.query(`ALTER TABLE "temporary_mail_inbound_analyses" RENAME TO "mail_inbound_analyses"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_282e4280bb27e3440baae62d4b" ON "mail_inbound_analyses" ("messageId") `);
        await queryRunner.query(`CREATE INDEX "IDX_064226a7f1303b8f8e4ffb47fa" ON "mail_inbound_analyses" ("threadId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7c1c48e89e0b83b24910a71d42" ON "mail_inbound_analyses" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_adbb2d33d5d7b3c5833876fa5b" ON "mail_inbound_analyses" ("companyId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_adbb2d33d5d7b3c5833876fa5b"`);
        await queryRunner.query(`DROP INDEX "IDX_7c1c48e89e0b83b24910a71d42"`);
        await queryRunner.query(`DROP INDEX "IDX_064226a7f1303b8f8e4ffb47fa"`);
        await queryRunner.query(`DROP INDEX "IDX_282e4280bb27e3440baae62d4b"`);
        await queryRunner.query(`ALTER TABLE "mail_inbound_analyses" RENAME TO "temporary_mail_inbound_analyses"`);
        await queryRunner.query(`CREATE TABLE "mail_inbound_analyses" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "accountId" varchar NOT NULL, "threadId" varchar NOT NULL, "messageId" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('running'), "employeeId" varchar, "modelId" varchar, "category" varchar NOT NULL DEFAULT (''), "summary" text NOT NULL DEFAULT (''), "actionsJson" text NOT NULL DEFAULT ('[]'), "errorMessage" text NOT NULL DEFAULT (''), "finishedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "autoActionsJson" text NOT NULL DEFAULT ('[]'))`);
        await queryRunner.query(`INSERT INTO "mail_inbound_analyses"("id", "companyId", "accountId", "threadId", "messageId", "status", "employeeId", "modelId", "category", "summary", "actionsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt", "autoActionsJson") SELECT "id", "companyId", "accountId", "threadId", "messageId", "status", "employeeId", "modelId", "category", "summary", "actionsJson", "errorMessage", "finishedAt", "createdAt", "updatedAt", "autoActionsJson" FROM "temporary_mail_inbound_analyses"`);
        await queryRunner.query(`DROP TABLE "temporary_mail_inbound_analyses"`);
        await queryRunner.query(`CREATE INDEX "IDX_adbb2d33d5d7b3c5833876fa5b" ON "mail_inbound_analyses" ("companyId") `);
        await queryRunner.query(`CREATE INDEX "IDX_7c1c48e89e0b83b24910a71d42" ON "mail_inbound_analyses" ("accountId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_064226a7f1303b8f8e4ffb47fa" ON "mail_inbound_analyses" ("threadId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_282e4280bb27e3440baae62d4b" ON "mail_inbound_analyses" ("messageId") `);
        await queryRunner.query(`DROP INDEX "IDX_d660c1a79309e10a68636f3616"`);
        await queryRunner.query(`DROP INDEX "IDX_12779fbbd68b3999e2ddc73c84"`);
        await queryRunner.query(`DROP INDEX "IDX_d48fbd2a266b9b270989d8d445"`);
        await queryRunner.query(`DROP INDEX "IDX_057cfd33f8f915fc96c39dcc9f"`);
        await queryRunner.query(`DROP INDEX "IDX_195e91587b7279fa9074d1d972"`);
        await queryRunner.query(`ALTER TABLE "todo_pickups" RENAME TO "temporary_todo_pickups"`);
        await queryRunner.query(`CREATE TABLE "todo_pickups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "todoId" varchar NOT NULL, "employeeId" varchar NOT NULL, "trigger" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "hold" varchar, "authority" varchar NOT NULL DEFAULT ('employee'), "requesterUserId" varchar, "requesterSessionVersion" integer, "startedByMember" boolean NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "proactiveReview" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "mailThreadId" varchar, "note" text NOT NULL DEFAULT (''), "rerunJson" text, "priorStatus" varchar, "notBeforeAt" datetime, "workerId" varchar, "leaseExpiresAt" datetime, "attempt" integer NOT NULL DEFAULT (0), "failures" integer NOT NULL DEFAULT (0), "acceptedAt" datetime NOT NULL, "endedAt" datetime, "stoppedByUserId" varchar, "errorMessage" text NOT NULL DEFAULT (''), "replyText" text NOT NULL DEFAULT (''), "activityJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "todo_pickups"("id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt") SELECT "id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt" FROM "temporary_todo_pickups"`);
        await queryRunner.query(`DROP TABLE "temporary_todo_pickups"`);
        await queryRunner.query(`CREATE INDEX "IDX_d660c1a79309e10a68636f3616" ON "todo_pickups" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_12779fbbd68b3999e2ddc73c84" ON "todo_pickups" ("todoId") WHERE "status" IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_d48fbd2a266b9b270989d8d445" ON "todo_pickups" ("todoId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_057cfd33f8f915fc96c39dcc9f" ON "todo_pickups" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_195e91587b7279fa9074d1d972" ON "todo_pickups" ("status", "notBeforeAt") `);
        await queryRunner.query(`DROP INDEX "IDX_6bf941dbb94d502a146ea1bf7f"`);
        await queryRunner.query(`DROP INDEX "IDX_f3011d35e8f3d4dda6cc9a9884"`);
        await queryRunner.query(`DROP TABLE "project_intakes"`);
    }

}
