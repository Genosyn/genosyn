import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { SupportMessageKind } from "../../../shared/support.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One line of a ticket's conversation: what a customer wrote, what the team or
 * an AI Employee replied, an internal note, or an automatic email.
 *
 * Bodies are a copy, not a reference to the mail mirror, on purpose. Disconnecting
 * a mailbox purges its mirror; what customers asked and what they were told must
 * outlive that. Attachment bytes stay on the mail server, as they do for the
 * Email section, so `attachmentsJson` is display metadata and a download goes
 * back to the mailbox.
 *
 * `(accountId, gmailMessageId)` is the replay guard: a message is captured once
 * however many sync passes or retries see it. A note has neither, and neither does
 * a chat message: it leaves both null, which never collide, and has a replay guard
 * of its own in `(chatVisitorId, chatClientId)`.
 *
 * `chatVisitorId` is the whole boundary of the Chat widget. A visitor's token reads
 * rows stamped with their own id and nothing else, so a note, a draft, or another
 * person's words can't reach a browser by any route that follows a ticket.
 */
@Entity("support_messages")
@Index(["ticketId", "sentAt", "id"])
@Index(["accountId", "gmailMessageId"], { unique: true })
@Index(["companyId", "messageIdHeader"])
@Index(["chatVisitorId", "chatSeq"], { unique: true })
@Index(["chatVisitorId", "chatClientId"], { unique: true })
export class SupportMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  ticketId!: string;

  @Column({ type: "varchar" })
  kind!: SupportMessageKind;

  @Column({ type: "varchar", nullable: true })
  accountId!: string | null;

  @Column({ type: "varchar", nullable: true })
  gmailMessageId!: string | null;

  /** The Chat widget visitor who may read this row. See the class doc. */
  @Column({ type: "varchar", nullable: true })
  chatVisitorId!: string | null;

  /** Its place in that visitor's conversation: the widget's cursor. */
  @Column({ type: "int", nullable: true })
  chatSeq!: number | null;

  /** The id the widget gave its own message, so a retry can't post it twice. */
  @Column({ type: "varchar", nullable: true })
  chatClientId!: string | null;

  /** "bounce", "auto_reply" or "bulk" when software wrote this rather than a person. */
  @Column({ type: "varchar", default: "" })
  automatedKind!: string;

  /** RFC 822 Message-ID, so a reply on a broken thread still finds its ticket. */
  @Column({ type: "varchar", default: "" })
  messageIdHeader!: string;

  @Column({ type: "varchar", default: "" })
  inReplyToHeader!: string;

  @Column({ type: "varchar", default: "" })
  fromName!: string;

  @Column({ type: "varchar", default: "" })
  fromEmail!: string;

  @Column({ type: "varchar", default: "" })
  subject!: string;

  /** The Member who wrote it. Null for a customer, an AI Employee or the server. */
  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  /** The AI Employee who wrote it. */
  @Column({ type: "varchar", nullable: true })
  authorEmployeeId!: string | null;

  /** No person pressed Send: the AI Employee's reply went out on its own. */
  @Column({ type: "boolean", default: false })
  sentByAi!: boolean;

  /** The AI draft this began as, when it did. */
  @Column({ type: "varchar", nullable: true })
  draftId!: string | null;

  @Column({ type: dateTimeColumnType })
  sentAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: "text", default: "" })
  toEmails!: string;

  @Column({ type: "text", default: "" })
  ccEmails!: string;

  @Column({ type: "text", default: "" })
  referencesHeader!: string;

  /** The full text, quoted history and all. */
  @Column({ type: "text", default: "" })
  bodyText!: string;

  @Column({ type: "text", default: "" })
  bodyHtml!: string;

  /** The new words alone: quoted history and sign-offs cut. What an AI Employee reads. */
  @Column({ type: "text", default: "" })
  cleanText!: string;

  /** JSON display metadata; see the class doc. */
  @Column({ type: "text", default: "[]" })
  attachmentsJson!: string;

  /** JSON `SupportCitation[]`: what an AI reply quoted. */
  @Column({ type: "text", default: "[]" })
  citationsJson!: string;
}
