import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type {
  TodoPickupHold,
  TodoPickupStatus,
  TodoPickupTrigger,
} from "../../../shared/todoPickups.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One session an AI Employee spends on one Todo. The queue of them is the
 * employee's work queue: a Todo handed over, by a person or a colleague, becomes
 * a `queued` row, and the heartbeat starts the next one for each employee.
 *
 * Built the way {@link ChannelTurn} is: a worker claims it with a short lease it
 * renews, so a restart hands it to the next worker instead of losing it, and its
 * steps are the shared activity feed keyed by this row's id and scoped to the
 * Todo (`services/chatTurnActivity.ts`). Its report is an ordinary
 * `TodoComment` linked by {@link TodoComment.pickupId}.
 *
 * A pickup carries what it may do, because nothing about a background session
 * can be read off the moment it runs. `authority` says whose access its tools
 * use. `mailDeliveryMode`, `proactiveReview` and `tainted` are ceilings it
 * inherits from whatever asked for it: assigning a Todo to a colleague from a
 * restricted or tainted turn cannot shed either.
 */
@Entity("todo_pickups")
@Index(["status", "notBeforeAt"])
@Index(["employeeId", "status"])
@Index(["todoId", "createdAt"])
// One at a time per Todo: its thread is the transcript each one replays.
@Index(["todoId"], { unique: true, where: `"status" IN ('queued', 'running')` })
export class TodoPickup {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  todoId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  trigger!: TodoPickupTrigger;

  @Column({ type: "varchar", default: "queued" })
  status!: TodoPickupStatus;

  /** Why a `queued` pickup is not running, for whoever is looking at it. */
  @Column({ type: "varchar", nullable: true })
  hold!: TodoPickupHold | null;

  @Column({ type: "varchar", default: "employee" })
  authority!: "member" | "employee";

  /** The Member whose authority a `member` pickup runs under. */
  @Column({ type: "varchar", nullable: true })
  requesterUserId!: string | null;

  /** That Member's auth epoch when it was asked for, re-checked before it runs. */
  @Column({ type: "int", nullable: true })
  requesterSessionVersion!: number | null;

  /** A person asked for this one directly, so the automatic limits don't apply. */
  @Column({ type: "boolean", default: false })
  startedByMember!: boolean;

  /**
   * A person chose, on the Todo, to lend this one session their access past the Todo's
   * limits. New outside words on the Todo clear it before the session starts.
   */
  @Column({ type: "boolean", default: false })
  overLimits!: boolean;

  /** The delivery ceiling it inherited. See `services/mail/deliveryPolicy.ts`. */
  @Column({ type: "varchar", nullable: true })
  mailDeliveryMode!: string | null;

  /** It may only prepare (`services/proactive/workReviewPolicy.ts`). */
  @Column({ type: "boolean", default: false })
  proactiveReview!: boolean;

  /** It starts tainted (`services/taintPolicy.ts`), or some attempt became so. */
  @Column({ type: "boolean", default: false })
  tainted!: boolean;

  /** The email thread its mail tools are bound to, when it has one. */
  @Column({ type: "varchar", nullable: true })
  mailThreadId!: string | null;

  /**
   * An owner named the sender of the email that started this on the Project's
   * intake, and the receiving server verified it (`services/todoIntake.ts`). It
   * keeps the browser open under a delivery ceiling, and nothing else.
   */
  @Column({ type: "boolean", default: false })
  trustedSender!: boolean;

  /** What the server wants this session to know about why it exists. */
  @Column({ type: "text", default: "" })
  note!: string;

  /** Another request arrived while it ran: what to queue once it ends. JSON. */
  @Column({ type: "text", nullable: true })
  rerunJson!: string | null;

  /** The Todo's status before this pickup moved it, to go back to if nothing happened. */
  @Column({ type: "varchar", nullable: true })
  priorStatus!: string | null;

  /** When the queue may start it. Always set while queued. */
  @Column({ type: dateTimeColumnType, nullable: true })
  notBeforeAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  workerId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  leaseExpiresAt!: Date | null;

  /** Times a worker started it: above 1 after a restart or a retry. */
  @Column({ type: "int", default: 0 })
  attempt!: number;

  /** Real failures so far, which back off and end it. An outage is not one. */
  @Column({ type: "int", default: 0 })
  failures!: number;

  /** When it was asked for, to the millisecond. Every elapsed clock counts from here. */
  @Column({ type: dateTimeColumnType })
  acceptedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  endedAt!: Date | null;

  /** The Member who pressed Stop, when one did. */
  @Column({ type: "varchar", nullable: true })
  stoppedByUserId!: string | null;

  /** Why it ended the way it did, when it did not simply finish. */
  @Column({ type: "text", default: "" })
  errorMessage!: string;

  /** The reply as far as it was written, for anyone following on another replica. */
  @Column({ type: "text", default: "" })
  replyText!: string;

  /** "Worked for 2m 14s · 9 steps", once it ended. JSON. */
  @Column({ type: "text", nullable: true })
  activityJson!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
