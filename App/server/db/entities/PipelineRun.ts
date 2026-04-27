import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type PipelineRunStatus = "running" | "completed" | "failed" | "skipped";
export type PipelineTriggerKind = "manual" | "schedule" | "webhook";

/**
 * One execution of a Pipeline. Mirrors the Run entity's shape (status +
 * captured log capped at 256KB). `triggerKind` + `triggerNodeId` record
 * which trigger fired when a pipeline has more than one. `inputJson` carries
 * the trigger payload (webhook body, manual fire payload) and `outputJson`
 * holds the per-node outputs map at end of run for inspection.
 */
@Entity("pipeline_runs")
@Index(["pipelineId", "startedAt"])
export class PipelineRun {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  pipelineId!: string;

  @Column({ type: "datetime" })
  startedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "varchar", default: "running" })
  status!: PipelineRunStatus;

  @Column({ type: "varchar", default: "manual" })
  triggerKind!: PipelineTriggerKind;

  @Column({ type: "varchar", nullable: true })
  triggerNodeId!: string | null;

  @Column({ type: "text", default: "{}" })
  inputJson!: string;

  @Column({ type: "text", default: "{}" })
  outputJson!: string;

  /** Captured per-node execution log. Capped — see RUN_LOG_MAX_BYTES. */
  @Column({ type: "text", default: "" })
  logContent!: string;

  @Column({ type: "varchar", nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
