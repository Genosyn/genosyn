import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * One turn in an email thread's AI conversation — the chat panel that sits
 * beside the opened email. Unlike a `Conversation` (which belongs to one
 * employee), this chat is scoped to a MailAccount + MailThread and any AI
 * employee can be @-tagged into it, so each assistant row records which
 * employee answered.
 *
 * `suggestionsJson` carries the structured action suggestions the employee
 * proposed via the `suggest_mail_actions` tool — the client renders them as
 * one-click buttons that execute through the ordinary human mail routes, so
 * a draft-level employee can propose a send the human approves with a click.
 */
@Entity("mail_chat_messages")
@Index(["companyId"])
@Index(["accountId", "createdAt"])
export class MailChatMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  /** Local MailThread id that owns this independent AI conversation. */
  @Column({ type: "varchar", nullable: true })
  threadId!: string | null;

  @Column({ type: "varchar" })
  role!: "user" | "assistant";

  /** The employee that answered (assistant rows only). */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /**
   * The AI Model this turn actually ran on, resolved at acceptance time.
   *
   * Persisted for the same reason employee chat persists it: reopening the
   * panel on the employee's *current* active model would silently swap brains
   * mid-conversation — different context window, different tool habits,
   * different bill — on a transcript the human reads as one conversation.
   * Null on human rows, and on assistant rows written before the picker
   * shipped or answered by an employee with no connected model.
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

  /** JSON MailActionSuggestion[] — one-click buttons the employee proposed. */
  @Column({ type: "text", default: "" })
  suggestionsJson!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
