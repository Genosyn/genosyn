import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * An AI Employee's access to Routines, set by owners and admins at
 * **Routines → AI access**:
 *
 *   - `write` → read + write: the employee reads every Routine and its Runs,
 *               its own Routines keep running, and it may create, edit,
 *               re-schedule, pause, re-file, and delete Routines through its
 *               tools. This is what every employee had before the setting
 *               existed, and it is still the default.
 *   - `run`   → read + run: the employee still reads every Routine and Run, and
 *               its Routines still run on their schedules, Triggers, webhooks,
 *               and a Member's Run now. It cannot change any Routine:
 *               `create_routine`, `update_routine`, and `delete_routine` are
 *               refused for every Routine, its own or a teammate's. No other AI
 *               Employee can change *its* Routines either, so a change cannot be
 *               routed through a teammate.
 *
 * "Run" is not a capability the employee exercises through a tool — Runs are
 * started by the scheduler, a Trigger, a webhook, or a Member — so the level
 * never gates a Run. It gates writes, and only writes.
 *
 * ## Absence means the default
 *
 * Like `EmployeeResourceLibraryGrant` (Resources → AI access), and unlike the
 * opt-in Finance / Revenue / Signing grants, no row means the default: every
 * AI Employee could always manage Routines, and the setting exists to narrow
 * that. An employee with no row holds {@link DEFAULT_ROUTINE_ACCESS}, so an
 * upgrade changes nothing until someone opts an employee down, and a new hire
 * needs no row. A stored value that is not a known level fails closed to `run`.
 *
 * One row per employee, like the other company-wide AI-access grants. Members
 * bypass this table entirely; it only governs the AI surface.
 */
export type RoutineAccessLevel = "run" | "write";

/** Narrowest first, the order the page lays them out in. */
export const ROUTINE_ACCESS_LEVELS: RoutineAccessLevel[] = ["run", "write"];

export const ROUTINE_ACCESS_RANK: Record<RoutineAccessLevel, number> = {
  run: 0,
  write: 1,
};

/** What an employee without a row holds. */
export const DEFAULT_ROUTINE_ACCESS: RoutineAccessLevel = "write";

@Entity("employee_routine_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeRoutineGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: DEFAULT_ROUTINE_ACCESS })
  accessLevel!: RoutineAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
