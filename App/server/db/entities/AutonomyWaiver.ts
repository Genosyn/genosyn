import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Which concrete gate the waiver switches off. A closed set on purpose —
 * every member of this union is one existing human gate whose waiving has
 * been individually reasoned about, not a free-form "trust level":
 *
 *  - `browser_approval` — `AIEmployee.browserApprovalRequired` off: the
 *    employee's browser form submits stop queueing Approvals.
 *  - `routine_approval` — `Routine.requiresApproval` off for the one Routine
 *    named by `routineId`: its cron ticks run without a human ✓.
 */
export type AutonomyWaiverKind = "browser_approval" | "routine_approval";

/**
 * An earned, revocable exemption from one human gate (M53).
 *
 * A waiver is never self-granted: the eligibility sweep computes the track
 * record from what M50 already measures and raises an Approval (kind
 * `autonomy_promotion`) — the system's idea, admin-gated, applying this
 * exact settings change on ✓. The row is the durable record that a gate is
 * off *because it was earned*, which is what makes automatic demotion
 * possible: any failed, timed-out, or off-goal Run by the employee revokes
 * its active waivers and re-arms the gates immediately. Demotion only ever
 * tightens, so it needs no human in the loop; promotion always keeps one.
 *
 * Vocabulary: this is a **Waiver** — never a "tier", "level", or "trust
 * score". See AGENTS.md §3.
 */
@Entity("autonomy_waivers")
@Index(["companyId", "employeeId"])
export class AutonomyWaiver {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  kind!: AutonomyWaiverKind;

  /** The Routine whose approval gate is waived, for `routine_approval`. */
  @Column({ type: "varchar", nullable: true })
  routineId!: string | null;

  /** The admin whose ✓ executed the promotion Approval. */
  @Column({ type: "varchar", nullable: true })
  grantedByUserId!: string | null;

  /** The server-computed evidence the promotion cited, kept for the record. */
  @Column({ type: "text", default: "" })
  evidence!: string;

  /** Null while the waiver is active. Set by automatic demotion or a human
   * revoking from the employee page; the gate is re-armed in the same act. */
  @Column({ type: dateTimeColumnType, nullable: true })
  revokedAt!: Date | null;

  @Column({ type: "text", default: "" })
  revokedReason!: string;

  @CreateDateColumn()
  grantedAt!: Date;
}
