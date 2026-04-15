import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A single message on a Todo's discussion thread. Authors are either a human
 * Member (`authorUserId`) or an AI Employee (`authorEmployeeId`) — exactly one
 * is set. Humans and employees participate in the same stream so a thread
 * reads like a normal chat between teammates, regardless of who's behind the
 * keyboard.
 *
 * When `pending` is true, an AI reply has been requested but hasn't come back
 * yet — the UI renders it as a skeleton until the background job fills in
 * `body` and clears the flag.
 */
@Entity("todo_comments")
export class TodoComment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  todoId!: string;

  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  authorEmployeeId!: string | null;

  @Column({ type: "text", default: "" })
  body!: string;

  /** True while an AI reply is in-flight. */
  @Column({ type: "boolean", default: false })
  pending!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
