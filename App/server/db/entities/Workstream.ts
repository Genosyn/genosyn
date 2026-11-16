import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * `active` is the only state that folds into briefs. Terminal states are
 * deliberate: multi-week work must end as "done" or "abandoned with a
 * reason", never by evaporating.
 */
export type WorkstreamStatus = "active" | "archived" | "done" | "abandoned";

/**
 * A **Workstream** — a persistent state document for work that spans many
 * Runs (M54): "collect these 40 overdue invoices", "migrate the CRM
 * import". Before this, the only memory between Runs was journal recall, so
 * any job longer than one sitting needed a human as the carrier of
 * work-in-progress. The employee maintains the state itself
 * (`update_workstream`, full replacement like a Revision proposal's body),
 * and a bound Routine's every Run brief opens with the latest state instead
 * of re-reading a week of journal.
 *
 * Not a Project: a Project is the humans' task manager, with assignees and
 * boards. A Workstream is one employee's own working state — closer to a
 * scratchpad with a lifecycle than to a board. See AGENTS.md §3.
 */
@Entity("workstreams")
@Index(["companyId", "status"])
// A Routine that runs only when a Workstream is due asks, before every
// scheduled time, for this employee's active Workstreams whose revisit came.
@Index(["employeeId", "status", "revisitAt"])
export class Workstream {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The employee whose work this is — the only one who may update it. */
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  title!: string;

  /** What done means, in prose — written once at creation. */
  @Column({ type: "text", default: "" })
  objective!: string;

  /** The living state document: checklist, per-item status, blockers,
   * artifacts by reference. Model-written; rendered as prose, never parsed. */
  @Column({ type: "text", default: "" })
  stateDoc!: string;

  /** The Routine whose Run briefs open with this state, or null for a
   * workstream advanced from chat and Wakeups only. One Routine binds at
   * most one active workstream — the write path enforces it. */
  @Column({ type: "varchar", nullable: true })
  routineId!: string | null;

  @Column({ type: "varchar", default: "active" })
  status!: WorkstreamStatus;

  /** Required when abandoned — work never just evaporates. */
  @Column({ type: "text", default: "" })
  closeReason!: string;

  /** The last Run that advanced the state, for the paper trail. */
  @Column({ type: "varchar", nullable: true })
  lastRunId!: string | null;

  /**
   * When the employee next needs to look at this work — the one part of its
   * plan the server reads, since the state document is prose and never parsed.
   * The employee sets it with `create_workstream` / `update_workstream`; null
   * means nothing is waiting on a time. A Routine whose run condition is
   * `workstream_due` (Follow through on open work) starts only once a revisit
   * has come and it has not run since (`shared/routineRunCondition.ts`), so
   * idle work costs no model turn. Cleared when the Workstream stops being
   * active.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  revisitAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
