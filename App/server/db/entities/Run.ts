import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type RunStatus = "running" | "completed" | "failed" | "skipped" | "timeout" | "interrupted";

/**
 * How a completed Run measured against its Routine's acceptance criteria,
 * judged by a restricted zero-tool checker after the transcript was final.
 *
 * `achieved` — the evidence shows the criteria were met.
 * `off_goal`  — the Run finished but the work does not satisfy the criteria.
 * `unclear`   — the checker looked and could not tell either way.
 * `unverified`— **the check never produced a judgement**: the checker errored,
 *               timed out, or ended without submitting.
 *
 * The last two used to be the same word, and that collision was load-bearing
 * in the wrong direction: every consumer downstream read "we could not verify"
 * as "nothing was wrong", so a checker outage quietly earned an employee the
 * same credit as a graded success. They are now separate, and `unverified`
 * counts against promotion exactly like a bad Run.
 *
 * Null when the Routine declares no criteria, or for Runs that predate the
 * column.
 */
export type RunOutcomeVerdict = "achieved" | "unclear" | "off_goal" | "unverified";

/**
 * Whether this Run's **required Checks** passed — the third axis, and the only
 * one no model has a say in.
 *
 * `passed`  — every required Check passed (possibly after remediation).
 * `failed`  — at least one required Check did not pass, or could not be run.
 * `not_run` — the Routine declares no enabled Checks.
 *
 * Null for Runs that never reached the check phase (a failure, a timeout, a
 * Run that predates the column). Like `outcomeVerdict`, it never changes
 * `status`: `completed` keeps meaning "the loop returned", and the
 * consequences attach to the axis rather than to the status.
 */
export type RunChecksVerdict = "passed" | "failed" | "not_run";

/**
 * What caused a Run to start. Only `schedule` and `retry` runs are ever
 * retried automatically — the other three had a caller present who saw the
 * outcome and can decide for themselves.
 */
export type RunTrigger = "schedule" | "manual" | "webhook" | "approval" | "retry" | "event";

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
   * Captured model text and tool activity, plus runner framing lines (headers,
   * timeouts, errors). The DB is the source of truth: the runner checkpoints
   * this column while a Run is active, then writes the final transcript when
   * it finishes. Hard-capped at {@link RUN_LOG_MAX_BYTES} to keep a runaway
   * Run from blowing up the row — we keep the first N bytes and append a
   * truncation marker once the cap is hit.
   */
  @Column({ type: "text", default: "" })
  logContent!: string;

  /**
   * Zero for a completed Run. Null for Runs without a clean completion:
   * `skipped`, `timeout`, `interrupted`, and model/tool failures.
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
   * failed-routines panel while a retry is still pending. Dispatch temporarily
   * replaces the due time with an internal, expiring compare-and-set claim;
   * callers should treat any non-null value as queued or starting.
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

  /** See {@link RunOutcomeVerdict}. Written once, after the transcript is final. */
  @Column({ type: "varchar", nullable: true })
  outcomeVerdict!: RunOutcomeVerdict | null;

  /**
   * The checker's one-or-two-sentence reason for the verdict — what the
   * transcript showed or failed to show. Null whenever `outcomeVerdict` is.
   */
  @Column({ type: "text", nullable: true })
  outcomeNote!: string | null;

  /**
   * When the outcome check last reached a judgement of any kind — including
   * `unverified`. This is the predicate the re-grade sweep keys on: a process
   * that died inside the two-minute verdict window used to strand its Run with
   * a null verdict forever, and a null verdict counted as clean. Null means
   * "nobody has graded this yet", which is now a thing the platform notices
   * rather than a thing it rewards.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  outcomeCheckedAt!: Date | null;

  /** See {@link RunChecksVerdict}. Written before the terminal status save. */
  @Column({ type: "varchar", nullable: true })
  checksVerdict!: RunChecksVerdict | null;

  /**
   * How many bounded remediation rounds the runner spent trying to turn a
   * failing check green. 0 when the checks passed first time or the Routine
   * declares none.
   */
  @Column({ type: "integer", default: 0 })
  checkRemediations!: number;

  /**
   * Prompt tokens this Run consumed, summed across every model turn from the
   * provider's own per-turn counts (each turn's prompt is billed in full, so
   * the sum is what the Run actually cost — not the final context size).
   * Includes the outcome-verdict turn when one ran. 0 for Runs that predate
   * the column or never reached a model.
   */
  @Column({ type: "integer", default: 0 })
  tokensIn!: number;

  /** Completion tokens this Run consumed, same accounting as {@link tokensIn}. */
  @Column({ type: "integer", default: 0 })
  tokensOut!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
