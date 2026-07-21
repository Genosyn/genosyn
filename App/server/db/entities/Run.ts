import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type RunStatus = "running" | "completed" | "failed" | "skipped" | "timeout";

// Run history, the Home failed-routines roll-up, and System Health all filter
// by routineId and a startedAt window; without this the queries full-scan the
// highest-volume table in the app. Mirrors the pipeline_runs index.
@Entity("runs")
@Index(["routineId", "startedAt"])
export class Run {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  routineId!: string;

  @Column({ type: dateTimeColumnType })
  startedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "varchar" })
  status!: RunStatus;

  /**
   * Captured stdout+stderr from the provider CLI, plus runner framing lines
   * (headers, timeouts, errors). Previously this was a path to a log file on
   * disk; the DB is now the source of truth and the runner buffers output in
   * memory until the child closes. Hard-capped at {@link RUN_LOG_MAX_BYTES}
   * to keep a runaway CLI from blowing up the row — we keep the first N
   * bytes and append a truncation marker once the cap is hit.
   */
  @Column({ type: "text", default: "" })
  logContent!: string;

  /**
   * CLI exit code when the child closed under its own power. Null for runs
   * that never reached `close` — `skipped` (no CLI invoked) and `timeout`
   * (we SIGKILL'd it). `failed` runs typically have a non-zero code here.
   */
  @Column({ type: "integer", nullable: true })
  exitCode!: number | null;

  /**
   * When a member acknowledged this failed/timed-out run from the Home
   * "Failed routines" panel. Non-null rows are hidden from that panel and
   * from the System Health "Failed routine runs" check, so an
   * already-noticed failure stops nagging the whole company. The run itself
   * is left intact — this only suppresses the alert. Null for runs nobody
   * has dismissed (the default). The acting member + time are also written
   * to the audit log.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  dismissedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
