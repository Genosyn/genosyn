import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 *  - `pending`   — waiting for its time.
 *  - `fired`     — the heartbeat dispatched the session (or the journal
 *                  fallback when the employee had no model).
 *  - `cancelled` — the employee or a Member called it off first.
 */
export type EmployeeWakeupStatus = "pending" | "fired" | "cancelled";

/**
 * A **Wakeup** — the timed follow-up an employee schedules for itself (M54):
 * "check back on the invoice in two days", with a brief its future self
 * reads. The one wake source the platform genuinely lacked — Decisions,
 * Handoffs, todos, and inbound mail already start sessions the moment they
 * land (M50/M53, Mail rules); time did not.
 *
 * Deliberately a fresh briefed session, not a parked transcript: the
 * codebase has standardized on that shape four times, and a two-day-old
 * transcript is stale context where a two-line brief is not. Dispatch is
 * claimed with a conditional UPDATE on the heartbeat, the retry-dispatch
 * pattern, so one session starts however many schedulers race.
 */
@Entity("employee_wakeups")
// The heartbeat's hot query — due pending wakeups, oldest first.
@Index(["status", "at"])
export class EmployeeWakeup {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  /** When to wake. */
  @Column({ type: dateTimeColumnType })
  at!: Date;

  /** The note the employee left for its future self — the whole brief. */
  @Column({ type: "text", default: "" })
  brief!: string;

  /** Where it was scheduled from, best-effort provenance like a Decision's. */
  @Column({ type: "varchar", nullable: true })
  sourceRunId!: string | null;

  @Column({ type: "varchar", nullable: true })
  sourceRoutineId!: string | null;

  @Column({ type: "varchar", default: "pending" })
  status!: EmployeeWakeupStatus;

  @Column({ type: dateTimeColumnType, nullable: true })
  firedAt!: Date | null;

  /** What the wake session reported, or why none ran. */
  @Column({ type: "text", default: "" })
  outcomeNote!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
