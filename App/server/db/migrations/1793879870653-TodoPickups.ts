import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoPickups1793879870653 implements MigrationInterface {
    name = 'TodoPickups1793879870653'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "todo_pickups" ("id" varchar PRIMARY KEY NOT NULL, "companyId" varchar NOT NULL, "todoId" varchar NOT NULL, "employeeId" varchar NOT NULL, "trigger" varchar NOT NULL, "status" varchar NOT NULL DEFAULT ('queued'), "hold" varchar, "authority" varchar NOT NULL DEFAULT ('employee'), "requesterUserId" varchar, "requesterSessionVersion" integer, "startedByMember" boolean NOT NULL DEFAULT (0), "mailDeliveryMode" varchar, "proactiveReview" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "mailThreadId" varchar, "note" text NOT NULL DEFAULT (''), "rerunJson" text, "priorStatus" varchar, "notBeforeAt" datetime, "workerId" varchar, "leaseExpiresAt" datetime, "attempt" integer NOT NULL DEFAULT (0), "failures" integer NOT NULL DEFAULT (0), "acceptedAt" datetime NOT NULL, "endedAt" datetime, "stoppedByUserId" varchar, "errorMessage" text NOT NULL DEFAULT (''), "replyText" text NOT NULL DEFAULT (''), "activityJson" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`CREATE INDEX "IDX_d660c1a79309e10a68636f3616" ON "todo_pickups" ("companyId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_12779fbbd68b3999e2ddc73c84" ON "todo_pickups" ("todoId") WHERE "status" IN ('queued', 'running')`);
        await queryRunner.query(`CREATE INDEX "IDX_d48fbd2a266b9b270989d8d445" ON "todo_pickups" ("todoId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_057cfd33f8f915fc96c39dcc9f" ON "todo_pickups" ("employeeId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_195e91587b7279fa9074d1d972" ON "todo_pickups" ("status", "notBeforeAt") `);
        await queryRunner.query(`DROP INDEX "IDX_fbbeb7fb00740df25d6e65d36b"`);
        await queryRunner.query(`DROP INDEX "IDX_df804b7a6fa13c874b10903da9"`);
        await queryRunner.query(`CREATE TABLE "temporary_todos" ("id" varchar PRIMARY KEY NOT NULL, "projectId" varchar NOT NULL, "number" integer NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('todo'), "priority" varchar NOT NULL DEFAULT ('none'), "assigneeEmployeeId" varchar, "createdById" varchar, "dueAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "recurrence" varchar NOT NULL DEFAULT ('none'), "recurrenceParentId" varchar, "assigneeUserId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar, "parentTodoId" varchar, "aiReviewPasses" integer NOT NULL DEFAULT (0), "untrustedText" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "aiChainDepth" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "temporary_todos"("id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses") SELECT "id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses" FROM "todos"`);
        await queryRunner.query(`DROP TABLE "todos"`);
        await queryRunner.query(`ALTER TABLE "temporary_todos" RENAME TO "todos"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbbeb7fb00740df25d6e65d36b" ON "todos" ("projectId", "number") `);
        await queryRunner.query(`CREATE INDEX "IDX_df804b7a6fa13c874b10903da9" ON "todos" ("parentTodoId") `);
        await queryRunner.query(`DROP INDEX "IDX_0a36029ae5b303dc642ebbdec6"`);
        await queryRunner.query(`CREATE TABLE "temporary_todo_comments" ("id" varchar PRIMARY KEY NOT NULL, "todoId" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "body" text NOT NULL DEFAULT (''), "pending" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "pickupId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_todo_comments"("id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt") SELECT "id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt" FROM "todo_comments"`);
        await queryRunner.query(`DROP TABLE "todo_comments"`);
        await queryRunner.query(`ALTER TABLE "temporary_todo_comments" RENAME TO "todo_comments"`);
        await queryRunner.query(`CREATE INDEX "IDX_0a36029ae5b303dc642ebbdec6" ON "todo_comments" ("todoId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_0a36029ae5b303dc642ebbdec6"`);
        await queryRunner.query(`ALTER TABLE "todo_comments" RENAME TO "temporary_todo_comments"`);
        await queryRunner.query(`CREATE TABLE "todo_comments" ("id" varchar PRIMARY KEY NOT NULL, "todoId" varchar NOT NULL, "authorUserId" varchar, "authorEmployeeId" varchar, "body" text NOT NULL DEFAULT (''), "pending" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await queryRunner.query(`INSERT INTO "todo_comments"("id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt") SELECT "id", "todoId", "authorUserId", "authorEmployeeId", "body", "pending", "createdAt", "updatedAt" FROM "temporary_todo_comments"`);
        await queryRunner.query(`DROP TABLE "temporary_todo_comments"`);
        await queryRunner.query(`CREATE INDEX "IDX_0a36029ae5b303dc642ebbdec6" ON "todo_comments" ("todoId") `);
        await queryRunner.query(`DROP INDEX "IDX_df804b7a6fa13c874b10903da9"`);
        await queryRunner.query(`DROP INDEX "IDX_fbbeb7fb00740df25d6e65d36b"`);
        await queryRunner.query(`ALTER TABLE "todos" RENAME TO "temporary_todos"`);
        await queryRunner.query(`CREATE TABLE "todos" ("id" varchar PRIMARY KEY NOT NULL, "projectId" varchar NOT NULL, "number" integer NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('todo'), "priority" varchar NOT NULL DEFAULT ('none'), "assigneeEmployeeId" varchar, "createdById" varchar, "dueAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "recurrence" varchar NOT NULL DEFAULT ('none'), "recurrenceParentId" varchar, "assigneeUserId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar, "parentTodoId" varchar, "aiReviewPasses" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "todos"("id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses") SELECT "id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses" FROM "temporary_todos"`);
        await queryRunner.query(`DROP TABLE "temporary_todos"`);
        await queryRunner.query(`CREATE INDEX "IDX_df804b7a6fa13c874b10903da9" ON "todos" ("parentTodoId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbbeb7fb00740df25d6e65d36b" ON "todos" ("projectId", "number") `);
        await queryRunner.query(`DROP INDEX "IDX_195e91587b7279fa9074d1d972"`);
        await queryRunner.query(`DROP INDEX "IDX_057cfd33f8f915fc96c39dcc9f"`);
        await queryRunner.query(`DROP INDEX "IDX_d48fbd2a266b9b270989d8d445"`);
        await queryRunner.query(`DROP INDEX "IDX_12779fbbd68b3999e2ddc73c84"`);
        await queryRunner.query(`DROP INDEX "IDX_d660c1a79309e10a68636f3616"`);
        await queryRunner.query(`DROP TABLE "todo_pickups"`);
    }

}
