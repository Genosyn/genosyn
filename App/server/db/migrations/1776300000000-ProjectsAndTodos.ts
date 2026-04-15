import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the Projects + Todos task-manager tables. See ROADMAP.md V1 backlog.
 */
export class ProjectsAndTodos1776300000000 implements MigrationInterface {
  name = "ProjectsAndTodos1776300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "projects" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "description" text NOT NULL DEFAULT (''),
        "key" varchar NOT NULL,
        "createdById" varchar,
        "todoCounter" integer NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_projects_companyId_slug" ON "projects" ("companyId", "slug")`,
    );

    await queryRunner.query(
      `CREATE TABLE "todos" (
        "id" varchar PRIMARY KEY NOT NULL,
        "projectId" varchar NOT NULL,
        "number" integer NOT NULL,
        "title" varchar NOT NULL,
        "description" text NOT NULL DEFAULT (''),
        "status" varchar NOT NULL DEFAULT ('todo'),
        "priority" varchar NOT NULL DEFAULT ('none'),
        "assigneeEmployeeId" varchar,
        "createdById" varchar,
        "dueAt" datetime,
        "sortOrder" float NOT NULL DEFAULT (0),
        "completedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_todos_projectId_number" ON "todos" ("projectId", "number")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_todos_projectId_number"`);
    await queryRunner.query(`DROP TABLE "todos"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "projects"`);
  }
}
