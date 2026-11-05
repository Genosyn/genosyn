import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoCeiling1793890916694 implements MigrationInterface {
    name = 'TodoCeiling1793890916694'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_b8cb9a07318f3ee98906a1e480"`);
        await queryRunner.query(`DROP INDEX "IDX_fbbeb7fb00740df25d6e65d36b"`);
        await queryRunner.query(`DROP INDEX "IDX_df804b7a6fa13c874b10903da9"`);
        await queryRunner.query(`CREATE TABLE "temporary_todos" ("id" varchar PRIMARY KEY NOT NULL, "projectId" varchar NOT NULL, "number" integer NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('todo'), "priority" varchar NOT NULL DEFAULT ('none'), "assigneeEmployeeId" varchar, "createdById" varchar, "dueAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "recurrence" varchar NOT NULL DEFAULT ('none'), "recurrenceParentId" varchar, "assigneeUserId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar, "parentTodoId" varchar, "aiReviewPasses" integer NOT NULL DEFAULT (0), "untrustedText" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "aiChainDepth" integer NOT NULL DEFAULT (0), "waitingOn" varchar, "waitingRefId" varchar, "waitingReason" text NOT NULL DEFAULT (''), "waitingSince" datetime, "waitingCheckAt" datetime, "followUpCount" integer NOT NULL DEFAULT (0), "ceilingJson" text)`);
        await queryRunner.query(`INSERT INTO "temporary_todos"("id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses", "untrustedText", "tainted", "aiChainDepth", "waitingOn", "waitingRefId", "waitingReason", "waitingSince", "waitingCheckAt", "followUpCount") SELECT "id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses", "untrustedText", "tainted", "aiChainDepth", "waitingOn", "waitingRefId", "waitingReason", "waitingSince", "waitingCheckAt", "followUpCount" FROM "todos"`);
        await queryRunner.query(`DROP TABLE "todos"`);
        await queryRunner.query(`ALTER TABLE "temporary_todos" RENAME TO "todos"`);
        await queryRunner.query(`CREATE INDEX "IDX_b8cb9a07318f3ee98906a1e480" ON "todos" ("waitingOn", "waitingRefId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbbeb7fb00740df25d6e65d36b" ON "todos" ("projectId", "number") `);
        await queryRunner.query(`CREATE INDEX "IDX_df804b7a6fa13c874b10903da9" ON "todos" ("parentTodoId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_df804b7a6fa13c874b10903da9"`);
        await queryRunner.query(`DROP INDEX "IDX_fbbeb7fb00740df25d6e65d36b"`);
        await queryRunner.query(`DROP INDEX "IDX_b8cb9a07318f3ee98906a1e480"`);
        await queryRunner.query(`ALTER TABLE "todos" RENAME TO "temporary_todos"`);
        await queryRunner.query(`CREATE TABLE "todos" ("id" varchar PRIMARY KEY NOT NULL, "projectId" varchar NOT NULL, "number" integer NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('todo'), "priority" varchar NOT NULL DEFAULT ('none'), "assigneeEmployeeId" varchar, "createdById" varchar, "dueAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "recurrence" varchar NOT NULL DEFAULT ('none'), "recurrenceParentId" varchar, "assigneeUserId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar, "parentTodoId" varchar, "aiReviewPasses" integer NOT NULL DEFAULT (0), "untrustedText" boolean NOT NULL DEFAULT (0), "tainted" boolean NOT NULL DEFAULT (0), "aiChainDepth" integer NOT NULL DEFAULT (0), "waitingOn" varchar, "waitingRefId" varchar, "waitingReason" text NOT NULL DEFAULT (''), "waitingSince" datetime, "waitingCheckAt" datetime, "followUpCount" integer NOT NULL DEFAULT (0))`);
        await queryRunner.query(`INSERT INTO "todos"("id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses", "untrustedText", "tainted", "aiChainDepth", "waitingOn", "waitingRefId", "waitingReason", "waitingSince", "waitingCheckAt", "followUpCount") SELECT "id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId", "parentTodoId", "aiReviewPasses", "untrustedText", "tainted", "aiChainDepth", "waitingOn", "waitingRefId", "waitingReason", "waitingSince", "waitingCheckAt", "followUpCount" FROM "temporary_todos"`);
        await queryRunner.query(`DROP TABLE "temporary_todos"`);
        await queryRunner.query(`CREATE INDEX "IDX_df804b7a6fa13c874b10903da9" ON "todos" ("parentTodoId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbbeb7fb00740df25d6e65d36b" ON "todos" ("projectId", "number") `);
        await queryRunner.query(`CREATE INDEX "IDX_b8cb9a07318f3ee98906a1e480" ON "todos" ("waitingOn", "waitingRefId") `);
    }

}
