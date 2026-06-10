import { MigrationInterface, QueryRunner } from "typeorm";

export class TodoSubtasks1782300000000 implements MigrationInterface {
    name = 'TodoSubtasks1782300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_fbbeb7fb00740df25d6e65d36b"`);
        await queryRunner.query(`CREATE TABLE "temporary_todos" ("id" varchar PRIMARY KEY NOT NULL, "projectId" varchar NOT NULL, "number" integer NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('todo'), "priority" varchar NOT NULL DEFAULT ('none'), "assigneeEmployeeId" varchar, "createdById" varchar, "dueAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "recurrence" varchar NOT NULL DEFAULT ('none'), "recurrenceParentId" varchar, "assigneeUserId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar, "parentTodoId" varchar)`);
        await queryRunner.query(`INSERT INTO "temporary_todos"("id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId") SELECT "id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId" FROM "todos"`);
        await queryRunner.query(`DROP TABLE "todos"`);
        await queryRunner.query(`ALTER TABLE "temporary_todos" RENAME TO "todos"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbbeb7fb00740df25d6e65d36b" ON "todos" ("projectId", "number") `);
        await queryRunner.query(`CREATE INDEX "IDX_df804b7a6fa13c874b10903da9" ON "todos" ("parentTodoId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_df804b7a6fa13c874b10903da9"`);
        await queryRunner.query(`DROP INDEX "IDX_fbbeb7fb00740df25d6e65d36b"`);
        await queryRunner.query(`ALTER TABLE "todos" RENAME TO "temporary_todos"`);
        await queryRunner.query(`CREATE TABLE "todos" ("id" varchar PRIMARY KEY NOT NULL, "projectId" varchar NOT NULL, "number" integer NOT NULL, "title" varchar NOT NULL, "description" text NOT NULL DEFAULT (''), "status" varchar NOT NULL DEFAULT ('todo'), "priority" varchar NOT NULL DEFAULT ('none'), "assigneeEmployeeId" varchar, "createdById" varchar, "dueAt" datetime, "sortOrder" float NOT NULL DEFAULT (0), "completedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "recurrence" varchar NOT NULL DEFAULT ('none'), "recurrenceParentId" varchar, "assigneeUserId" varchar, "reviewerEmployeeId" varchar, "reviewerUserId" varchar)`);
        await queryRunner.query(`INSERT INTO "todos"("id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId") SELECT "id", "projectId", "number", "title", "description", "status", "priority", "assigneeEmployeeId", "createdById", "dueAt", "sortOrder", "completedAt", "createdAt", "updatedAt", "recurrence", "recurrenceParentId", "assigneeUserId", "reviewerEmployeeId", "reviewerUserId" FROM "temporary_todos"`);
        await queryRunner.query(`DROP TABLE "temporary_todos"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_fbbeb7fb00740df25d6e65d36b" ON "todos" ("projectId", "number") `);
    }

}
