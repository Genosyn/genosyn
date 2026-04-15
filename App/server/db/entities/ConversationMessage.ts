import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * One turn in a {@link Conversation}. `role` is `user` for humans and
 * `assistant` for the AI employee. `status` mirrors the chat service's result
 * shape so the UI can render skipped/error turns distinctly — NULL on user
 * messages, one of `ok`/`skipped`/`error` on assistant replies.
 */
export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "ok" | "skipped" | "error";

@Entity("conversation_messages")
export class ConversationMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  conversationId!: string;

  @Column({ type: "varchar" })
  role!: ConversationMessageRole;

  @Column({ type: "text", default: "" })
  content!: string;

  @Column({ type: "varchar", nullable: true })
  status!: ConversationMessageStatus | null;

  @CreateDateColumn()
  createdAt!: Date;
}
