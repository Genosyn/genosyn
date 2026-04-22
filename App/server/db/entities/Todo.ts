import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type TodoStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

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

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "datetime", nullable: true })
  dueAt!: Date | null;

  /** Float sort key for drag-to-reorder within a status column. */
  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  @Column({ type: "varchar", default: "none" })
  recurrence!: TodoRecurrence;

  /** Links a spawned instance back to the todo that was completed to create it. */
  @Column({ type: "varchar", nullable: true })
  recurrenceParentId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
