import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * What one activity event in a work session turn is.
 *
 *   - `text`        → narration the employee wrote between tool calls.
 *   - `tool_use`    → the employee called a tool; `name`, `callId`, and the
 *                     arguments (in `detailJson`) are recorded before it runs.
 *   - `tool_result` → that call returned; paired with its `tool_use` by
 *                     `callId`. `summary` is the one-line outcome, `detailJson`
 *                     the bounded output.
 *   - `steps`       → the employee updated its step list (its plan for the
 *                     turn). `detailJson` holds the whole list; the latest
 *                     event is the current state.
 *   - `progress`    → an explicit `report_progress` call.
 *   - `compact`     → older tool results were dropped to fit the context
 *                     window.
 *   - `retry`       → the model call was retried after a transient failure.
 *   - `stopped`     → a Member stopped the turn.
 */
export type RepositoryWorkSessionEventKind =
  | "text"
  | "tool_use"
  | "tool_result"
  | "steps"
  | "progress"
  | "compact"
  | "retry"
  | "stopped";

/**
 * One thing that happened while an AI Employee worked on a session turn.
 *
 * A turn used to be recorded as its instruction and its reply, and nothing in
 * between. That is the shape of a request, not of work: for the minutes or
 * hours a turn runs, the Member saw a spinner, and afterwards they could not
 * tell which files were read, which command failed, or what the employee was
 * thinking when it made the change they are now reviewing. Every agentic
 * coding tool people already use shows exactly that, live, and it is most of
 * what makes their output trustworthy.
 *
 * Events are append-only rows rather than a JSON column on the turn: a turn
 * can produce hundreds of them, the client reads them incrementally
 * (`?after=<ordinal>`), and rewriting a growing blob on every tool call is the
 * wrong shape for both. Nothing here is the durable record of the *work* —
 * that is still the branch, the commits, and the turn's reply. This is the
 * record of how the work was done.
 */
@Entity("repository_work_session_events")
@Index(["sessionId", "ordinal"])
@Index(["turnId"])
@Index(["companyId"])
export class RepositoryWorkSessionEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Carried so live sync can scope the change to the repository's page. */
  @Column({ type: "varchar" })
  repositoryId!: string;

  @Column({ type: "varchar" })
  sessionId!: string;

  @Column({ type: "varchar" })
  turnId!: string;

  /** Position in the session, across turns, so a reader can ask for "after N". */
  @Column({ type: "int" })
  ordinal!: number;

  @Column({ type: "varchar" })
  kind!: RepositoryWorkSessionEventKind;

  /** The tool name for `tool_use` / `tool_result`; empty otherwise. */
  @Column({ type: "varchar", default: "" })
  name!: string;

  /** Pairs a `tool_result` with its `tool_use`. Empty for other kinds. */
  @Column({ type: "varchar", default: "" })
  callId!: string;

  /** One line a person can read in a list: "Read src/app.ts", "Ran npm test → exit 1". */
  @Column({ type: "text", default: "" })
  summary!: string;

  /**
   * Bounded structured detail: tool arguments, output, a diff snippet, the
   * step list. Kept small on purpose — the writer clips it — because this is
   * shown in a feed, not archived.
   */
  @Column({ type: "text", default: "" })
  detailJson!: string;

  /** True when a `tool_result` reported an error. */
  @Column({ type: "boolean", default: false })
  isError!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
