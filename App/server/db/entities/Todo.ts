import { dateTimeColumnType } from "./columnTypes.js";
import type { TodoWaitKind } from "../../../shared/todoPickups.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type TodoStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export type TodoPriority = "none" | "low" | "medium" | "high" | "urgent";

/**
 * Repeat cadence for a recurring todo. When the todo transitions to `done`,
 * the server spawns a fresh todo with the same title / priority / assignee
 * and a new `dueAt` = previous `dueAt` (or now) + recurrence period.
 * `none` keeps the todo as a one-shot.
 */
export type TodoRecurrence =
  | "none"
  | "daily"
  | "weekdays"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly";

/**
 * A Todo is a single work item inside a Project. Can be assigned to an AI
 * Employee — when a routine doesn't fit, a todo is the unit of work an
 * employee picks up. See ROADMAP.md "Task manager".
 */
@Entity("todos")
@Index(["projectId", "number"], { unique: true })
// What a Decision, a reviewed email or an email thread looks up to find the Todo
// waiting on it.
@Index(["waitingOn", "waitingRefId"])
export class Todo {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  projectId!: string;

  /** Per-project sequence (1,2,3,…). Combined with Project.key for display. */
  @Column({ type: "int" })
  number!: number;

  @Column({ type: "varchar" })
  title!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "varchar", default: "todo" })
  status!: TodoStatus;

  @Column({ type: "varchar", default: "none" })
  priority!: TodoPriority;

  /** AIEmployee assignee. Null = unassigned. Mutually exclusive with assigneeUserId. */
  @Column({ type: "varchar", nullable: true })
  assigneeEmployeeId!: string | null;

  /** Human Member assignee. Null = unassigned. Mutually exclusive with assigneeEmployeeId. */
  @Column({ type: "varchar", nullable: true })
  assigneeUserId!: string | null;

  /**
   * AI Employee reviewer. When an assignee moves the todo to `in_review`,
   * the reviewer is the one expected to sign it off. Mutually exclusive
   * with reviewerUserId; either column being null means "no reviewer yet".
   */
  @Column({ type: "varchar", nullable: true })
  reviewerEmployeeId!: string | null;

  /** Human Member reviewer. Mutually exclusive with reviewerEmployeeId. */
  @Column({ type: "varchar", nullable: true })
  reviewerUserId!: string | null;

  /**
   * How many AI review sessions this todo has had (`services/reviewKickoff.ts`).
   * Counted on the row rather than inferred from the comment thread, because
   * an AI reviewer also comments when a human @-mentions it — inferring would
   * let ordinary thread chatter silently disable reviewing. Two AI teammates
   * can otherwise bounce a card between review and rework indefinitely, so
   * past the cap in `reviewKickoff.ts` the card waits for a human instead.
   */
  @Column({ type: "integer", default: 0 })
  aiReviewPasses!: number;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  dueAt!: Date | null;

  /** Float sort key for drag-to-reorder within a status column. */
  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  completedAt!: Date | null;

  @Column({ type: "varchar", default: "none" })
  recurrence!: TodoRecurrence;

  /** Links a spawned instance back to the todo that was completed to create it. */
  @Column({ type: "varchar", nullable: true })
  recurrenceParentId!: string | null;

  /**
   * Parent todo when this row is a subtask. One level deep only: a todo
   * with a parent can't itself be a parent. Subtasks live in the same
   * project, keep their own status/assignee, and are deleted with their
   * parent.
   */
  @Index()
  @Column({ type: "varchar", nullable: true })
  parentTodoId!: string | null;

  /**
   * A Member did not write this Todo's title and description: an AI Employee
   * did, or a Pipeline's template. They are what was asked for, never an
   * instruction, so a session reads them as data
   * (`services/todoPickupBrief.ts`). It never clears: a person fixing a typo has
   * not vouched for the rest.
   */
  @Column({ type: "boolean", default: false })
  untrustedText!: boolean;

  /**
   * Words a tainted turn wrote are on this Todo, so every session that replays
   * its thread starts tainted (`services/taintPolicy.ts`). There is no untaint.
   */
  @Column({ type: "boolean", default: false })
  tainted!: boolean;

  /**
   * The most an automatic session on this Todo may do, as JSON: a stranger's email
   * or a restricted turn touched it, so everything that follows it is held to that
   * (`services/todoPickups.ts`). It only narrows. Only a Member asking for a session
   * themselves runs outside it, and that doesn't lift it for what comes after.
   */
  @Column({ type: "text", nullable: true })
  ceilingJson!: string | null;

  /**
   * What this `in_progress` Todo is waiting on, or null when it isn't. A state of
   * `in_progress` rather than a status of its own (`services/todoWaits.ts`).
   */
  @Column({ type: "varchar", nullable: true })
  waitingOn!: TodoWaitKind | null;

  /** What it is waiting on exactly: a mail thread, a Decision, an Approval. */
  @Column({ type: "varchar", nullable: true })
  waitingRefId!: string | null;

  /** Why, in the AI Employee's words. */
  @Column({ type: "text", default: "" })
  waitingReason!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  waitingSince!: Date | null;

  /** When it checks back. A queued pickup holds the actual turn in the queue. */
  @Column({ type: dateTimeColumnType, nullable: true })
  waitingCheckAt!: Date | null;

  /** Times it has checked back with no reply since someone last answered. */
  @Column({ type: "int", default: 0 })
  followUpCount!: number;

  /**
   * How many AI hand-offs led here. A Todo created or handed on inside a pickup
   * is one deeper than the Todo that pickup was on; past the limit in
   * `services/todoPickups.ts` it is saved and starts nothing.
   */
  @Column({ type: "int", default: 0 })
  aiChainDepth!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
