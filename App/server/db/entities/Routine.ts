import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * See {@link Routine.catchUpPolicy}. A string union rather than a boolean so a
 * future replay-every-missed-slot policy can be added without a column change.
 */
export type CatchUpPolicy = "once" | "skip";

@Entity("routines")
@Index(["employeeId", "slug"], { unique: true })
// The heartbeat's hot query — `enabled = true AND nextRunAt <= now`, every 30
// seconds. Both sibling schedulers already index their equivalent column.
@Index(["enabled", "nextRunAt"])
export class Routine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "varchar" })
  cronExpr!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastRunAt!: Date | null;

  /**
   * The next wall-clock time this routine is scheduled to fire, derived from
   * `cronExpr`. The heartbeat in `services/cron.ts` looks for enabled routines
   * whose `nextRunAt` is due and runs them. Null when disabled, when the cron
   * expression fails to parse, or briefly on fresh rows before the schedule is
   * computed. See `registerRoutine()` / `nextRunFor()` for the write seam.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  nextRunAt!: Date | null;

  /**
   * Markdown brief — what used to live at `routines/<slug>/README.md` on
   * disk. The runner folds this into the prompt each time the routine fires;
   * the Routine editor round-trips through `/api/.../routines/:rid/readme`.
   */
  @Column({ type: "text", default: "" })
  body!: string;

  /**
   * Per-routine hard timeout in seconds. The runner SIGKILLs the CLI after
   * this long and marks the Run `timeout`. Default 60 min (`3600`) gives
   * long-running agent work room to finish without letting a wedged process
   * hold a license / API quota indefinitely. Editable per routine from the
   * Routine editor (10 s – 6 h).
   */
  @Column({ type: "integer", default: 3600 })
  timeoutSec!: number;

  /**
   * If true, cron ticks enqueue an {@link Approval} instead of running. A
   * human decides from the Approvals inbox. Manual "Run now" from the UI
   * still runs immediately — a human is already in the loop.
   */
  @Column({ type: "boolean", default: false })
  requiresApproval!: boolean;

  /**
   * Optional HTTP trigger. When enabled, external systems can POST to
   * `/api/webhooks/r/:routineId/:webhookToken` to fire this routine. The
   * token is the only secret; regenerate by toggling off and back on.
   */
  @Column({ type: "boolean", default: false })
  webhookEnabled!: boolean;

  @Column({ type: "varchar", nullable: true })
  webhookToken!: string | null;

  /**
   * Optional pin to one of the employee's {@link AIModel} rows — the brain
   * this routine runs on. Null (default) inherits whichever model is active
   * for the employee, so routines follow the employee's brain unless an
   * operator deliberately pins one (a cheap model for a noisy hourly digest,
   * a stronger one for the weekly report).
   *
   * Only ever points at a model owned by the same employee — the PATCH route
   * rejects a foreign id, and deleting a model clears the routines pinned to
   * it. Resolution still falls back to the active model if the pin dangles;
   * see `resolveRoutineModel()` in `services/models.ts`.
   *
   * Chat is unaffected — this pin applies to the routine's runs only.
   */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  /**
   * Per-routine override for the employee's `browserEnabled` flag. Three
   * states:
   *
   *   * `null` (default) — inherit `AIEmployee.browserEnabled`.
   *   * `true` — force-enable for this routine even when the employee
   *     setting is off (rare; useful for a single scheduled scrape on an
   *     otherwise air-gapped employee).
   *   * `false` — force-disable for this routine even when the employee
   *     setting is on (common; keep the employee browser-capable for
   *     ad-hoc chat work but withhold it from a noisy cron).
   *
   * Stored as a stringified boolean (`"true"` / `"false"`) so sqlite's
   * boolean column can still distinguish the three cases via nullable.
   */
  @Column({ type: "boolean", nullable: true })
  browserEnabledOverride!: boolean | null;

  /**
   * What to do when the server was unavailable across one or more of this
   * routine's scheduled slots.
   *
   *   * `"once"` (default) — fire exactly one catch-up run however many slots
   *     were missed, and record the count on the Run. This is the historical
   *     behaviour; only the count is new.
   *   * `"skip"` — don't fire at all when the due slot is already more than a
   *     minute stale; just re-anchor to the next future slot. For work that is
   *     only meaningful on time — a 09:00 standup digest arriving at 16:00 is
   *     noise, not a catch-up.
   *
   * Missed slots are never replayed one-for-one. A routine produces at most
   * one scheduled run per heartbeat pass, whatever the outage length.
   */
  @Column({ type: "varchar", default: "once" })
  catchUpPolicy!: CatchUpPolicy;

  /**
   * Total attempts for one scheduled occurrence, counting the first. `1`
   * (default) means no retry — the historical behaviour. Capped at 5 by the
   * API.
   *
   * Retries are **at-least-once** for side effects: a run that sent an email
   * and then died will send it again. Only raise this on routines whose work
   * is safe to repeat.
   */
  @Column({ type: "integer", default: 1 })
  maxAttempts!: number;

  /**
   * Base for full-jitter exponential backoff between attempts: the wait before
   * attempt N is a random slice of `retryBackoffSec * 2^(N-1)`, capped at six
   * hours. Inert while `maxAttempts` is 1.
   */
  @Column({ type: "integer", default: 60 })
  retryBackoffSec!: number;

  /**
   * Whether a `timeout` is retryable. Separate from failed/interrupted because
   * retrying a timeout re-burns the routine's whole `timeoutSec` of model
   * spend — up to six hours — so it is opted into on its own.
   */
  @Column({ type: "boolean", default: false })
  retryOnTimeout!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
