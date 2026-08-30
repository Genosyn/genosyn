import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

import type { RoutineCheckKind } from "./RoutineCheck.js";

/**
 * One Check's result on one Run.
 *
 * `name`, `kind`, and `required` are denormalized on purpose: a result is
 * evidence about a Run that already happened, and it has to stay readable
 * after somebody edits or deletes the Check that produced it. `checkId` goes
 * null in that case rather than taking the history with it — the same stance
 * `RunLesson` takes toward its Routine.
 */
@Entity("run_check_results")
// The only query: every result for one Run, in the order they ran.
@Index(["runId", "attempt"])
export class RunCheckResult {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  runId!: string;

  /** Null once the Check itself is gone. See the class note. */
  @Column({ type: "varchar", nullable: true })
  checkId!: string | null;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "effect" })
  kind!: RoutineCheckKind;

  @Column({ type: "boolean", default: true })
  required!: boolean;

  @Column({ type: "boolean", default: false })
  passed!: boolean;

  /** Exit status for a `command` check. Null for `effect`, and for a check
   * that could not be run at all. */
  @Column({ type: "integer", nullable: true })
  exitCode!: number | null;

  /**
   * Why it landed the way it did: the command's output tail, the predicate's
   * arithmetic ("expected at least 1 `mail.send`, the ledger has 0"), or the
   * reason the check could not run. A check that could not run records
   * `passed: false` with the reason here — "we could not verify" reading as
   * "verified" is the bug this whole milestone exists to remove, and it would
   * be absurd to reintroduce it inside the fix.
   */
  @Column({ type: "text", default: "" })
  detail!: string;

  @Column({ type: "integer", default: 0 })
  durationMs!: number;

  /**
   * Which round produced this result: 0 is the first pass, 1 and 2 are the
   * bounded remediation rounds. Keeping every round is what makes the strip
   * honest about a Run that only went green on the second try.
   */
  @Column({ type: "integer", default: 0 })
  attempt!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
