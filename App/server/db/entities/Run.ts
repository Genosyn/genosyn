import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "timeout"
  | "interrupted";

/**
 * What caused a Run to start. Only `schedule` and `retry` runs are ever
 * retried automatically — the other three had a caller present who saw the
 * outcome and can decide for themselves.
 */
export type RunTrigger = "schedule" | "manual" | "webhook" | "approval" | "retry";

// Run history, the Home failed-routines roll-up, and System Health all filter
// by routineId and a startedAt window; without this the queries full-scan the
// highest-volume table in the app. Mirrors the pipeline_runs index.
@Entity("runs")
@Index(["routineId", "startedAt"])
// The crash reconciler sweeps `status = "running"` on every heartbeat and the
// System Health stuck-run check filters the same way.
@Index(["status", "startedAt"])
// The heartbeat's retry scan: terminal rows carrying a due `retryAt`.
@Index(["retryAt"])
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
   * that never reached `close` — `skipped` (no CLI invoked), `timeout` (we
   * SIGKILL'd it), and `interrupted` (the process died, so nobody was left to
   * observe an exit). `failed` runs typically have a non-zero code here.
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

  /**
   * What caused this run. Named `triggerKind` rather than `trigger` because
   * TRIGGER is a reserved SQL keyword. See {@link RunTrigger}.
   */
  @Column({ type: "varchar", default: "schedule" })
  triggerKind!: RunTrigger;

  /**
   * 1-based attempt number within a retry chain. Always read from the row,
   * never from process memory, so a crash mid-chain resumes at the right count
   * instead of restarting the budget at 1.
   */
  @Column({ type: "integer", default: 1 })
  attempt!: number;

  /** The run this one is a retry of. Null for first attempts. */
  @Column({ type: "varchar", nullable: true })
  parentRunId!: string | null;

  /**
   * When the heartbeat should start the next attempt. Written on the
   * **terminal** row alongside its final status, in the same save, so "a retry
   * is owed" survives a second crash without needing a non-terminal queue
   * state. Cleared the moment the retry is dispatched. Null means no further
   * attempt is owed — which is also what stops the row nagging from the Home
   * failed-routines panel while a retry is still pending.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  retryAt!: Date | null;

  /**
   * Scheduled occurrences that elapsed while the server was unavailable and
   * are collapsed into this one catch-up run. 0 normally. Non-zero is the only
   * durable record that work was skipped — the scheduler advances `nextRunAt`
   * from *now* after an outage, so the missed slots leave no other trace.
   */
  @Column({ type: "integer", default: 0 })
  missedSlots!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
