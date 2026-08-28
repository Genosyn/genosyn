import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Where a Goal's `currentValue` comes from.
 *
 *  - `manual` — a number a Member or an AI Employee reports
 *    (`update_goal_progress`); the platform never computes it.
 *  - `chart`  — the first numeric cell of the bound Explore Chart's result,
 *    refreshed by the goals sweep on the scheduler heartbeat. The same
 *    "first cell of the first row" contract the `scalar` viz renders.
 */
export type GoalMetricKind = "manual" | "chart";

/**
 * Which way the metric must move for the Goal to count as met.
 * `increase_to` is met when `currentValue >= targetValue` (MRR, signups);
 * `decrease_to` when `currentValue <= targetValue` (churn, error rate).
 */
export type GoalDirection = "increase_to" | "decrease_to";

/**
 * `active` is the only state the sweep advances from: it settles `achieved`
 * when the target is met and `missed` when `dueAt` passes unmet, each
 * claimed with a conditional UPDATE so notifications fire exactly once.
 * `archived` is the human off-switch — an archived Goal is never graded,
 * injected, or swept, and archiving is always reversible back to `active`.
 */
export type GoalStatus = "active" | "achieved" | "missed" | "archived";

/**
 * A measurable objective the company is steering toward — the machine-readable
 * layer above Routines that M50's verdicts had no notion of. A Goal carries a
 * target value with a direction, an optional deadline, an optional owning AI
 * Employee (accountability, prompt injection), an optional parent Goal
 * (cascading company → employee), and a metric source.
 *
 * Routines point at a Goal via `Routine.goalId`, so scheduled work declares
 * what objective it serves; the Run brief and the outcome checker both see
 * the Goal. Vocabulary: this is a **Goal**, never an "OKR" / "KPI" / "Target"
 * — see AGENTS.md §3.
 *
 * FKs are bare varchar ids like every sibling entity — `parentGoalId`,
 * `ownerEmployeeId`, and `chartId` live on different lifecycles and are
 * cleaned up by hand at the service layer (deleting a Chart demotes the Goal
 * to `manual`; firing an employee clears ownership; deleting a parent
 * re-parents children to the deleted Goal's own parent, the RoutineFolder
 * rule).
 */
@Entity("goals")
@Index(["companyId", "slug"], { unique: true })
// The sweep's hot query — active Goals per company, and the chart-bound
// subset it refreshes each heartbeat.
@Index(["companyId", "status"])
export class Goal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** Why this Goal exists and what "done" means in prose — shown on the
   * Goals page and injected under the title wherever the Goal is folded
   * into a prompt. */
  @Column({ type: "text", default: "" })
  description!: string;

  /** Cascading objectives: null for a top-level (company) Goal. Deleting a
   * parent re-parents its children to the parent's own parent. */
  @Column({ type: "varchar", nullable: true })
  parentGoalId!: string | null;

  /** The AI Employee accountable for this Goal, or null for an unowned
   * company Goal. Ownership drives prompt injection: an employee's active
   * Goals ride into its system prompt. */
  @Column({ type: "varchar", nullable: true })
  ownerEmployeeId!: string | null;

  @Column({ type: "varchar", default: "manual" })
  metricKind!: GoalMetricKind;

  /** The Explore Chart whose first numeric cell is `currentValue` when
   * `metricKind` is `chart`; null otherwise. */
  @Column({ type: "varchar", nullable: true })
  chartId!: string | null;

  /** The metric's baseline when the Goal was set — what progress percent is
   * measured from. Null means no baseline: progress renders as
   * current-vs-target only. */
  @Column({ type: "real", nullable: true })
  startValue!: number | null;

  @Column({ type: "real" })
  targetValue!: number;

  @Column({ type: "real", nullable: true })
  currentValue!: number | null;

  /** When `currentValue` last changed — by the sweep, a Member, or an
   * employee's `update_goal_progress`. Null until the first report. */
  @Column({ type: dateTimeColumnType, nullable: true })
  currentValueUpdatedAt!: Date | null;

  @Column({ type: "varchar", default: "increase_to" })
  direction!: GoalDirection;

  /** Free-text unit label rendered beside values — "$", "%", "signups".
   * Display only; never parsed. */
  @Column({ type: "varchar", default: "" })
  unit!: string;

  /** Deadline. Null means open-ended: the Goal can be achieved but never
   * `missed`. */
  @Column({ type: dateTimeColumnType, nullable: true })
  dueAt!: Date | null;

  @Column({ type: "varchar", default: "active" })
  status!: GoalStatus;

  /** When the sweep (or a manual status change) settled `achieved` /
   * `missed`. Cleared when a human reactivates the Goal. */
  @Column({ type: dateTimeColumnType, nullable: true })
  settledAt!: Date | null;

  /** Authoring bookkeeping, mirroring `Chart`: a human Member id. Goals are
   * human-set intent — AI Employees report progress but never author
   * definitions, so there is no `createdByEmployeeId` twin. */
  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
