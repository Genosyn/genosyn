import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoLimits1793897067693 implements MigrationInterface {
    name = 'TodoLimits1793897067693'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0a36029ae5b303dc642ebbdec6"`);
        await queryRunner.query(`CREATE TABLE "temporary_todo_comments" ("id" varchar PRIMARY KEY NOT NULL, "todoId" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "body" text NOT NULL DEFAULT (''), "pending" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "pickupId" varchar, "systemNote" boolean NOT NULL DEFAULT (0), "fromLimitedTurn" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_todo_comments"("id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt", "pickupId", "systemNote") SELECT "id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt", "pickupId", "systemNote" FROM "todo_comments"`);
        await queryRunner.query(`DROP TABLE "todo_comments"`);
        await queryRunner.query(`ALTER TABLE "temporary_todo_comments" RENAME TO "todo_comments"`);
        await queryRunner.query(`CREATE INDEX "IDX_0a36029ae5b303dc642ebbdec6" ON "todo_comments" ("todoId") `);
        await queryRunner.query(`DROP INDEX "IDX_d660c1a79309e10a68636f3616"`);
        await queryRunner.query(`DROP INDEX "IDX_12779fbbd68b3999e2ddc73c84"`);
        await queryRunner.query(`DROP INDEX "IDX_d48fbd2a266b9b270989d8d445"`);
        await queryRunner.query(`DROP INDEX "IDX_057cfd33f8f915fc96c39dcc9f"`);
        await queryRunner.query(`DROP INDEX "IDX_195e91587b7279fa9074d1d972"`);
        await queryRunner.query(`CREATE TABLE "temporary_todo_pickups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "todoId" varchar NOT NULL, "employeeId" varchar NOT NULL, "trigger" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "hold" varchar, "authority" varchar NOT NULL DEFAULT ('employee'), "requesterUserId" varchar, "requesterSessionVersion" integer, "startedByMember" boolean NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "proactiveReview" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "mailThreadId" varchar, "note" text NOT NULL DEFAULT (''), "rerunJson" text, "priorStatus" varchar, "notBeforeAt" datetime, "workerId" varchar, "leaseExpiresAt" datetime, "attempt" integer NOT NULL DEFAULT (0), "failures" integer NOT NULL DEFAULT (0), "acceptedAt" datetime NOT NULL, "endedAt" datetime, "stoppedByUserId" varchar, "errorMessage" text NOT NULL DEFAULT (''), "replyText" text NOT NULL DEFAULT (''), "activityJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "trustedSender" boolean NOT NULL DEFAULT (0), "overLimits" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_todo_pickups"("id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt", "trustedSender") SELECT "id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt", "trustedSender" FROM "todo_pickups"`);
        await queryRunner.query(`DROP TABLE "todo_pickups"`);
        await queryRunner.query(`ALTER TABLE "temporary_todo_pickups" RENAME TO "todo_pickups"`);
        await queryRunner.query(`CREATE INDEX "IDX_d660c1a79309e10a68636f3616" ON "todo_pickups" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_12779fbbd68b3999e2ddc73c84" ON "todo_pickups" ("todoId") WHERE "status" IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_d48fbd2a266b9b270989d8d445" ON "todo_pickups" ("todoId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_057cfd33f8f915fc96c39dcc9f" ON "todo_pickups" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_195e91587b7279fa9074d1d972" ON "todo_pickups" ("status", "notBeforeAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_195e91587b7279fa9074d1d972"`);
        await queryRunner.query(`DROP INDEX "IDX_057cfd33f8f915fc96c39dcc9f"`);
        await queryRunner.query(`DROP INDEX "IDX_d48fbd2a266b9b270989d8d445"`);
        await queryRunner.query(`DROP INDEX "IDX_12779fbbd68b3999e2ddc73c84"`);
        await queryRunner.query(`DROP INDEX "IDX_d660c1a79309e10a68636f3616"`);
        await queryRunner.query(`ALTER TABLE "todo_pickups" RENAME TO "temporary_todo_pickups"`);
        await queryRunner.query(`CREATE TABLE "todo_pickups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "todoId" varchar NOT NULL, "employeeId" varchar NOT NULL, "trigger" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "hold" varchar, "authority" varchar NOT NULL DEFAULT ('employee'), "requesterUserId" varchar, "requesterSessionVersion" integer, "startedByMember" boolean NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "proactiveReview" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "mailThreadId" varchar, "note" text NOT NULL DEFAULT (''), "rerunJson" text, "priorStatus" varchar, "notBeforeAt" datetime, "workerId" varchar, "leaseExpiresAt" datetime, "attempt" integer NOT NULL DEFAULT (0), "failures" integer NOT NULL DEFAULT (0), "acceptedAt" datetime NOT NULL, "endedAt" datetime, "stoppedByUserId" varchar, "errorMessage" text NOT NULL DEFAULT (''), "replyText" text NOT NULL DEFAULT (''), "activityJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "trustedSender" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "todo_pickups"("id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt", "trustedSender") SELECT "id", "companyId", "todoId", "employeeId", "trigger", "status", "hold", "authority", "requesterUserId", "requesterSessionVersion", "startedByMember", "mailDeliveryMode", "proactiveReview", "tainted", "mailThreadId", "note", "rerunJson", "priorStatus", "notBeforeAt", "workerId", "leaseExpiresAt", "attempt", "failures", "acceptedAt", "endedAt", "stoppedByUserId", "errorMessage", "replyText", "activityJson", "createdAt", "updatedAt", "trustedSender" FROM "temporary_todo_pickups"`);
        await queryRunner.query(`DROP TABLE "temporary_todo_pickups"`);
        await queryRunner.query(`CREATE INDEX "IDX_195e91587b7279fa9074d1d972" ON "todo_pickups" ("status", "notBeforeAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_057cfd33f8f915fc96c39dcc9f" ON "todo_pickups" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_d48fbd2a266b9b270989d8d445" ON "todo_pickups" ("todoId", "createdAt") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_12779fbbd68b3999e2ddc73c84" ON "todo_pickups" ("todoId") WHERE "status" IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_d660c1a79309e10a68636f3616" ON "todo_pickups" ("companyId") `);
        await queryRunner.query(`DROP INDEX "IDX_0a36029ae5b303dc642ebbdec6"`);
        await queryRunner.query(`ALTER TABLE "todo_comments" RENAME TO "temporary_todo_comments"`);
        await queryRunner.query(`CREATE TABLE "todo_comments" ("id" varchar PRIMARY KEY NOT NULL, "todoId" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "body" text NOT NULL DEFAULT (''), "pending" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "pickupId" varchar, "systemNote" boolean NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "todo_comments"("id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt", "pickupId", "systemNote") SELECT "id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt", "pickupId", "systemNote" FROM "temporary_todo_comments"`);
        await queryRunner.query(`DROP TABLE "temporary_todo_comments"`);
        await queryRunner.query(`CREATE INDEX "IDX_0a36029ae5b303dc642ebbdec6" ON "todo_comments" ("todoId") `);
    }

}
