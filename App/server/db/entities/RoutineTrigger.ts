import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A **Trigger** — an event subscription that fires a Routine when a resource
 * family changes (M54). Rides the M31 live-sync spine exactly as it is:
 * `kind` is a coarse `resource.changed` family from the subscriber registry
 * ("deal", "mail", "run", …), the frame is id-only, and no row data ever
 * reaches the fired Run — the employee reads through its own grant-gated
 * tools, so an event widens nothing.
 *
 * Fires follow the webhook trigger's path verbatim: a gated Routine's fire
 * enqueues an Approval; otherwise the Run starts with
 * `triggerKind: "event"`. `minIntervalSec` is the loop bound — a Routine
 * that writes the family it subscribes to would otherwise fire itself on
 * every Run — claimed on `lastFiredAt` with a conditional UPDATE so racing
 * flushes fire once.
 *
 * Not a Revenue **Signal**: a Signal is a cron-evaluated query with
 * per-account dedupe; a Trigger is a change subscription with no query at
 * all. See AGENTS.md §3.
 */
@Entity("routine_triggers")
@Index(["companyId", "kind"])
export class RoutineTrigger {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  routineId!: string;

  /** A live-sync registry kind. Validated against the registry at write
   * time so a typo cannot create a subscription that never fires. */
  @Column({ type: "varchar" })
  kind!: string;

  /** Narrow to one parent scope id (a projectId, a routineId, a tableId —
   * whatever the kind's frames carry). Null fires on any change of the
   * kind. A frame whose scope set overflowed matches everything, exactly
   * as the client's live refetch does. */
  @Column({ type: "varchar", nullable: true })
  scopeId!: string | null;

  /** The self-trigger loop bound. */
  @Column({ type: "integer", default: 900 })
  minIntervalSec!: number;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /** The rate-limit claim — flipped with a conditional UPDATE by whichever
   * flush wins, so concurrent event bursts fire one Run. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastFiredAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
