import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type InitiativeStatus = "pending" | "accepted" | "declined";

/**
 * An **Initiative** — proactive work discovery (M54). Every unit of standing
 * work used to originate with a human: someone noticed the gap, scoped the
 * job, and wrote the Routine. An Initiative inverts the direction — an
 * employee that notices actionable slack in its own domain (mail nobody
 * answers, a report it rebuilds by hand) files the evidence, the case, and
 * the exact Routine it wants to run, and the human contribution collapses to
 * pressing Accept.
 *
 * Nothing exists until a human accepts — the TldrQuestionAction stance:
 * accepting is an admin's move, the created Routine is owned by the
 * proposing employee, and what is created is exactly what was shown
 * (`routineSpecJson`, validated at propose time so a reviewer never accepts
 * an unschedulable cron). Not a Decision (the employee is not blocked and
 * options are not the shape) and not a Revision proposal (nothing existing
 * is edited — something new is created).
 */
@Entity("initiatives")
@Index(["companyId", "status"])
export class Initiative {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The proposer, and the owner of whatever acceptance creates. */
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  title!: string;

  /** What the employee observed, with links — the reviewer reads this first. */
  @Column({ type: "text", default: "" })
  evidence!: string;

  /** The case: what standing work, and why it pays for itself. */
  @Column({ type: "text", default: "" })
  proposal!: string;

  /** JSON `{name, cronExpr, body, acceptanceCriteria?}` — the exact Routine
   * accept creates. Validated at propose time; parsed with a guarded reader
   * like every other JSON column. */
  @Column({ type: "text", default: "{}" })
  routineSpecJson!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: InitiativeStatus;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  decidedAt!: Date | null;

  @Column({ type: "text", default: "" })
  reviewNote!: string;

  /** The Routine acceptance created, for the paper trail. */
  @Column({ type: "varchar", nullable: true })
  createdRoutineId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
