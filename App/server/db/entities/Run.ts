import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "timeout";

@Entity("runs")
export class Run {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  routineId!: string;

  @Column({ type: "datetime" })
  startedAt!: Date;

  @Column({ type: "datetime", nullable: true })
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

  @CreateDateColumn()
  createdAt!: Date;
}
