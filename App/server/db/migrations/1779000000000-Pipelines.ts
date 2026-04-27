import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Pipelines (M10): n8n-style visual automation as a separate primitive from
 * Routines. The Pipeline row carries the graph JSON, plus a derived
 * `cronExpr`/`nextRunAt` so the existing heartbeat can pick up Schedule
 * triggers without parsing the graph each tick. PipelineRun mirrors the Run
 * entity for routines — captured log on the row, capped at 256KB by the
 * executor.
 */
export class Pipelines1779000000000 implements MigrationInterface {
  name = "Pipelines1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "pipelines" (
        "id" varchar PRIMARY KEY NOT NULL,
        "companyId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "description" text NOT NULL DEFAULT (''),
        "enabled" boolean NOT NULL DEFAULT (1),
        "graphJson" text NOT NULL DEFAULT ('{"nodes":[],"edges":[]}'),
        "cronExpr" varchar,
        "nextRunAt" datetime,
        "lastRunAt" datetime,
        "createdById" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_pipelines_companyId_slug" ON "pipelines" ("companyId", "slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pipelines_nextRunAt" ON "pipelines" ("nextRunAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE "pipeline_runs" (
        "id" varchar PRIMARY KEY NOT NULL,
        "pipelineId" varchar NOT NULL,
        "startedAt" datetime NOT NULL,
        "finishedAt" datetime,
        "status" varchar NOT NULL DEFAULT ('running'),
        "triggerKind" varchar NOT NULL DEFAULT ('manual'),
        "triggerNodeId" varchar,
        "inputJson" text NOT NULL DEFAULT ('{}'),
        "outputJson" text NOT NULL DEFAULT ('{}'),
        "logContent" text NOT NULL DEFAULT (''),
        "errorMessage" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pipeline_runs_pipelineId_startedAt" ON "pipeline_runs" ("pipelineId", "startedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipeline_runs_pipelineId_startedAt"`);
    await queryRunner.query(`DROP TABLE "pipeline_runs"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipelines_nextRunAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipelines_companyId_slug"`);
    await queryRunner.query(`DROP TABLE "pipelines"`);
  }
}
