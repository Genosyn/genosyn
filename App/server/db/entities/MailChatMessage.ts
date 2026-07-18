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

  @Column({ type: "text", default: "" })
  content!: string;

  /** Mirror of the chat seam's ChatResult status; null on user rows. */
  @Column({ type: "varchar", nullable: true })
  status!: "ok" | "skipped" | "error" | null;

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
