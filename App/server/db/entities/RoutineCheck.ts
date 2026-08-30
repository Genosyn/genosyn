import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * How a Check decides. Two kinds, chosen so that every install has at least
 * one usable one:
 *
 *  - `command` — a shell command run inside the same bubblewrap boundary the
 *    `bash` tool and `repository_run_command` use, rooted at the employee's
 *    working directory. Passes on exit 0. Only available where the sandbox can
 *    actually start, for the same reason `bash` is: host mode never gives an
 *    AI Employee a same-UID shell.
 *  - `effect` — a declarative predicate over the Run's **effect ledger** (the
 *    AuditEvent rows the server wrote at each write seam while this Run held
 *    the token). Needs no shell, no model, and no sandbox, so it works on a
 *    stock `disabled`-mode install. This is what keeps Checks from being a
 *    bubblewrap-only luxury.
 */
export type RoutineCheckKind = "command" | "effect";

/**
 * A **Check** — a machine-verifiable assertion a Run must pass before it may
 * finalize green. ROADMAP M52 deferred this with the words "machine-verifiable
 * assertions a Run must pass before it may finalize green, with bounded
 * remediation turns"; this is that row.
 *
 * The point of the primitive is that the graded party cannot author it. M50's
 * outcome verdict is a model reading a transcript the same model wrote — a
 * second opinion, but on the same evidence. A Check is the server observing
 * something the model cannot narrate: a command exited 0, or the ledger
 * actually contains the write the Run claims it performed. There is
 * deliberately no MCP tool that creates, edits, or deletes one (an employee
 * may *read* its Routine's Checks, so it can aim at the bar), and every
 * mutation is admin-gated at the route.
 *
 * Vocabulary: this is a **Check**, never a "test", "assertion", or "gate" —
 * see AGENTS.md §3. `services/systemHealth.ts` and `services/instanceHealth.ts`
 * say **probe** for their own diagnostics precisely so the word stays free.
 */
@Entity("routine_checks")
// The runner's hot query: every enabled check for one Routine, in order.
@Index(["routineId", "position"])
export class RoutineCheck {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Denormalized from the owning Routine's employee, like every sibling. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  routineId!: string;

  /**
   * What this check is for, in the operator's words. Rendered on the result
   * strip and folded into the Run brief, so the employee aims at the bar it
   * is graded against rather than discovering it afterwards.
   */
  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar", default: "effect" })
  kind!: RoutineCheckKind;

  /**
   * The assertion itself. For `command`, the shell command verbatim. For
   * `effect`, a JSON `EffectCheckSpec` — `{action, targetType?, min?, max?}`.
   * Parsed with a guarded reader like every other JSON column; a spec that no
   * longer parses fails its check loudly rather than passing silently.
   */
  @Column({ type: "text", default: "" })
  spec!: string;

  /**
   * A required check that does not pass fails the Run's `checksVerdict`. A
   * non-required check reports its result and changes nothing — the way to
   * watch a signal for a while before letting it stop work.
   */
  @Column({ type: "boolean", default: true })
  required!: boolean;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /**
   * Wall-clock ceiling for a `command` check. Always further clamped by what
   * remains of the Run's own absolute deadline, so checks can never extend
   * `Routine.timeoutSec`. Inert for `effect` checks, which are two queries.
   */
  @Column({ type: "integer", default: 120 })
  timeoutSec!: number;

  /** Ascending run order. Ties break on `createdAt`. */
  @Column({ type: "integer", default: 0 })
  position!: number;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
