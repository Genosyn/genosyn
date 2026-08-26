import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * One turn in a Routine's Ask AI conversation — the panel that sits beside an
 * opened Routine. Like the per-email chat, and unlike a `Conversation` (which
 * belongs to one employee), this chat is scoped to the Routine itself and any
 * AI employee can be @-tagged into it, so each assistant row records which
 * employee answered.
 *
 * The routine's own employee is the default target, because the question a
 * human opens this panel with is almost always about work that employee does.
 */
@Entity("routine_chat_messages")
@Index(["companyId"])
@Index(["routineId", "createdAt"])
export class RoutineChatMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  routineId!: string;

  @Column({ type: "varchar" })
  role!: "user" | "assistant";

  /** The employee that answered (assistant rows only). */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /**
   * The AI Model this turn actually ran on, resolved at acceptance time.
   *
   * Persisted for the same reason the per-email chat persists it: reopening
   * the panel on the employee's *current* active model would silently swap
   * brains mid-conversation — different context window, different tool habits,
   * different bill — on a transcript the human reads as one conversation.
   * Null on human rows, and on assistant rows answered by an employee with no
   * connected model.
   */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  @Column({ type: "text", default: "" })
  content!: string;

  /**
   * Mirror of the chat seam's ChatResult status; null on user rows.
   *
   * `working` is the in-flight state: the row is persisted before the model
   * runs, so a dropped browser connection (or a closed panel) can find the
   * turn again and follow it to its real answer instead of losing the reply.
   */
  @Column({ type: "varchar", nullable: true })
  status!: "working" | "ok" | "skipped" | "error" | null;

  /** JSON MessageAction[] — what the employee actually did this turn. */
  @Column({ type: "text", default: "" })
  actionsJson!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
