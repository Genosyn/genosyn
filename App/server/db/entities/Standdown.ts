import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * What a Standdown covers. Wider scopes subsume narrower ones: a `company`
 * standdown stops every employee and every Routine in it.
 */
export type StanddownScope = "company" | "employee" | "routine";

/**
 * Who placed it. `human` is somebody pressing the button; `breaker` is the
 * consecutive-failure circuit breaker in the runner. The distinction is
 * recorded rather than modelled as two entities because lifting one is the
 * same act either way — an admin deciding the work is safe to resume.
 */
export type StanddownSource = "human" | "breaker";

/**
 * A **Standdown** — a revocable stop on all AI work at one scope.
 *
 * Every guardrail before this one was per-action and pre-authorization: an
 * Approval holds one call, a Budget refuses one payment, a Policy blocks one
 * recipient. None of them answers "stop, now, everything" — and until this row
 * existed the honest answers were toggling `Routine.enabled` one row at a time
 * (which stops neither Wakeups, Triggers, mail automations, sequence ticks,
 * nor an employee somebody is chatting with) or deleting the employee.
 *
 * It is the exact inverse of an `AutonomyWaiver`: a Waiver is earned, narrow,
 * and widens what an employee may do without a human; a Standdown is imposed,
 * broad, and stops it. `Routine.enabled` stays the ordinary per-routine
 * switch and is untouched by this — a Standdown is the emergency instrument,
 * it records who and why, and it is the same primitive whether a human pressed
 * it or the breaker tripped it.
 *
 * Vocabulary: **Standdown**, never "pause" / "hold" (the docs already say
 * "held calls" for tainted-turn Approvals) / "suspend" / "freeze". Deliberately
 * has no MCP tool in either direction: the roster must not be able to stand
 * itself down, and far more importantly must not be able to lift one.
 */
@Entity("standdowns")
// The enforcement cache's only query: every active standdown in a company.
@Index(["companyId", "liftedAt"])
export class Standdown {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", default: "company" })
  scope!: StanddownScope;

  /** The employee or Routine id. Null for `company` scope. */
  @Column({ type: "varchar", nullable: true })
  scopeId!: string | null;

  /**
   * Why work stopped. Mandatory at the route — a stop nobody explained is a
   * stop nobody can safely lift. Shown on the banner, in the bell, and in the
   * journal entry every covered employee receives.
   */
  @Column({ type: "text", default: "" })
  reason!: string;

  @Column({ type: "varchar", default: "human" })
  source!: StanddownSource;

  /** Null when the breaker placed it. */
  @Column({ type: "varchar", nullable: true })
  placedByUserId!: string | null;

  @Column({ type: dateTimeColumnType })
  placedAt!: Date;

  /** Null while active. Non-null rows are history and enforce nothing. */
  @Column({ type: dateTimeColumnType, nullable: true })
  liftedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  liftedByUserId!: string | null;

  @Column({ type: "text", default: "" })
  liftedReason!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
