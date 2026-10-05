import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One Ask AI conversation — the chat window a Member opens from the top nav.
 *
 * Private to the Member who started it, for the same reason direct employee
 * chat is: every turn runs with that Member's authority and may carry the
 * records they had on screen, so another teammate replaying the transcript
 * would read context produced under somebody else's access.
 *
 * A conversation is not tied to a page. It follows the Member around the
 * product, and each human turn records what was on screen when it was sent
 * (`AskAiMessage.contextJson`), so "what about this one?" asked on a second
 * invoice means the second invoice.
 */
@Entity("ask_ai_conversations")
@Index(["companyId", "ownerUserId", "lastMessageAt"])
export class AskAiConversation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  ownerUserId!: string;

  /** Derived from the first human turn; null until something is sent. */
  @Column({ type: "varchar", nullable: true })
  title!: string | null;

  /** Ordering key for the conversation list — bumped on every human turn. */
  @Column({ type: dateTimeColumnType })
  lastMessageAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
