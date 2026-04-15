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

  /** AIEmployee assignee. Null = unassigned. */
  @Column({ type: "varchar", nullable: true })
  assigneeEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "datetime", nullable: true })
  dueAt!: Date | null;

  /** Float sort key for drag-to-reorder within a status column. */
  @Column({ type: "float", default: 0 })
  sortOrder!: number;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
