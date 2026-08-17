import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type DecisionStatus = "pending" | "decided" | "cancelled" | "expired";

/** How loudly a pending Decision sorts to the top of the stack. */
export type DecisionUrgency = "low" | "normal" | "high";

/**
 * How far the employee has got with the answer a human gave it.
 *
 *  - `none` — nobody has answered yet, or the row was dismissed/expired.
 *  - `running` — a work session is executing right now.
 *  - `done` — the session finished and left a report in `pickupSummary`.
 *  - `failed` — the session errored; `pickupSummary` says how.
 *  - `skipped` — we deliberately did not start one (no AI Model connected,
 *    for instance). The answer still reaches the employee through its journal
 *    on the next run, which is what `pickupSummary` explains.
 */
export type DecisionPickupStatus = "none" | "running" | "done" | "failed" | "skipped";

/**
 * One option on a Decision — a button a human can press.
 *
 * `id` is generated server-side from the label so the stored answer stays
 * meaningful when it is read back weeks later; `tone` only styles the button.
 */
export type DecisionOption = {
  id: string;
  label: string;
  /** Optional one-line elaboration under the button. */
  detail: string | null;
  tone: "primary" | "neutral" | "danger";
};

/**
 * A question an AI Employee stopped to ask a human, with the answers it will
 * accept. The Decision Stack on Home is the list of these still pending.
 *
 * **Not an {@link Approval}.** An Approval is the *system* interposing on an
 * action the employee already tried — a routine tick, a payment over a
 * threshold, a guarded tool call — and it replays that exact action server-side
 * once a human ticks it. It is binary, it is never the employee's idea, and
 * because it replays privileged side effects it is admin-gated and its payload
 * is redacted at every boundary.
 *
 * A Decision is the opposite shape. The employee *chose* to stop, wrote the
 * question and the options itself, and nothing is queued: answering it performs
 * no side effect at all. The employee reads the answer on its next turn
 * (`list_decisions`, plus a journal entry that lands in its next prompt) and
 * then does the work. That is why an ordinary Member can answer one — the
 * privileged actions that may follow still hit their own Approval gates.
 *
 * Provenance columns (`routineId`, `runId`, `conversationId`, `mailThreadId`)
 * are best-effort: they record where the employee was working when it asked, so
 * a human reading the stack can open the run, the chat, or the email thread the
 * question came out of instead of guessing at it.
 */
@Entity("decisions")
@Index(["companyId", "status"])
export class Decision {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  /** The AI Employee that raised the question. */
  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", nullable: true })
  routineId!: string | null;

  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  @Column({ type: "varchar", nullable: true })
  conversationId!: string | null;

  /**
   * The {@link MailThread} the employee was working when it asked — set when
   * the question came out of a mail handover or the per-email assistant, so
   * "which email is this about?" is a link rather than a guess.
   */
  @Column({ type: "varchar", nullable: true })
  mailThreadId!: string | null;

  /** The question itself, e.g. `Send the pricing reply to Acme?`. */
  @Column({ type: "varchar" })
  title!: string;

  /** Markdown context — the drafted email, the post copy, the trade-offs. */
  @Column({ type: "text", default: "" })
  body!: string;

  /** JSON-encoded {@link DecisionOption}[]. Between 1 and 6 entries. */
  @Column({ type: "text" })
  optionsJson!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: DecisionStatus;

  @Column({ type: "varchar", default: "normal" })
  urgency!: DecisionUrgency;

  /**
   * A specific Member this is for. Null means anyone in the company can answer.
   * When set, only that Member — or an owner/admin, so work never strands
   * behind someone on holiday — may decide.
   */
  @Column({ type: "varchar", nullable: true })
  assigneeUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  chosenOptionId!: string | null;

  /** Snapshot of the chosen label, so a read never has to re-parse the options. */
  @Column({ type: "varchar", nullable: true })
  chosenOptionLabel!: string | null;

  /** Free text the human added alongside the button they pressed. */
  @Column({ type: "text", nullable: true })
  note!: string | null;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  decidedAt!: Date | null;

  /** After this, the question is moot and the row sweeps itself to `expired`. */
  @Column({ type: dateTimeColumnType, nullable: true })
  expiresAt!: Date | null;

  /**
   * Pickup — the work session that runs the moment a human answers.
   *
   * A Decision is a *blocked* employee, so leaving the answer to be noticed on
   * the next routine tick can strand a drafted reply for a day. Answering
   * therefore starts a session immediately (see `services/decisionKickoff.ts`),
   * and these three columns are the durable record of it: they survive the
   * restart that kills the session, and they are what the stack renders instead
   * of a button that goes quiet.
   *
   * Still not an Approval: the session runs under the employee's own authority
   * and every privileged thing it then tries meets its own gate.
   */
  @Column({ type: "varchar", default: "none" })
  pickupStatus!: DecisionPickupStatus;

  /** The employee's report back, or why no session ran. */
  @Column({ type: "text", nullable: true })
  pickupSummary!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  pickupStartedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  pickupFinishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
