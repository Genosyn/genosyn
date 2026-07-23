import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Local mirror of one Gmail message (drafts included — a draft is a message
 * carrying the DRAFT label plus the `gmailDraftId` needed to edit/send it).
 *
 * Bodies are extracted once at ingest: `bodyText` from the text/plain part
 * (or stripped from HTML when there is none) and `bodyHtml` verbatim, each
 * capped at 512 KiB with a truncation marker. HTML is sanitized on the
 * client at render time (DOMPurify, same convention as chat markdown) — the
 * server stores what Gmail sent.
 *
 * `attachmentsJson` is display metadata only ([{ attachmentId, filename,
 * mimeType, size }]); attachment bytes are fetched from Gmail on demand and
 * never stored locally.
 */
@Entity("mail_messages")
@Index(["companyId"])
@Index(["threadId"])
@Index(["accountId", "gmailMessageId"], { unique: true })
export class MailMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  /** Local MailThread id (not the Gmail thread id). */
  @Column({ type: "varchar" })
  threadId!: string;

  @Column({ type: "varchar" })
  gmailMessageId!: string;

  @Column({ type: "varchar" })
  gmailThreadId!: string;

  /** Gmail draft id when this message is a draft; empty otherwise. */
  @Column({ type: "varchar", default: "" })
  gmailDraftId!: string;

  @Column({ type: "varchar", default: "" })
  fromName!: string;

  @Column({ type: "varchar", default: "" })
  fromEmail!: string;

  /** Comma-joined recipient lists, as they appeared in the headers. */
  @Column({ type: "text", default: "" })
  toEmails!: string;

  @Column({ type: "text", default: "" })
  ccEmails!: string;

  @Column({ type: "text", default: "" })
  bccEmails!: string;

  @Column({ type: "varchar", default: "" })
  subject!: string;

  @Column({ type: "text", default: "" })
  snippet!: string;

  @Column({ type: "text", default: "" })
  bodyText!: string;

  @Column({ type: "text", default: "" })
  bodyHtml!: string;

  /** Space-delimited Gmail label ids — same encoding as MailThread. */
  @Column({ type: "text", default: "" })
  labelIds!: string;

  /** Gmail internalDate. */
  @Column({ type: dateTimeColumnType, nullable: true })
  sentAt!: Date | null;

  /** RFC 822 Message-ID header — needed to thread replies correctly. */
  @Column({ type: "varchar", default: "" })
  messageIdHeader!: string;

  @Column({ type: "text", default: "" })
  referencesHeader!: string;

  @Column({ type: "varchar", default: "" })
  inReplyToHeader!: string;

  /** JSON array of attachment metadata — see class doc. */
  @Column({ type: "text", default: "[]" })
  attachmentsJson!: string;

  @Column({ type: "int", default: 0 })
  sizeEstimate!: number;

  /**
   * Who authored this message inside Genosyn. Exactly one of `createdByUserId`
   * (a human Member) and `createdByEmployeeId` (an AI Employee) is ever set —
   * the same "authored by a human or by an AI employee, never both" convention
   * Note and Chart use. Both stay null for mail Gmail synced in from the
   * outside world, and for drafts written before attribution shipped.
   */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  /**
   * Set only when an AI Employee wrote this while executing a Routine — the
   * MCP token carries the run/routine down from the runner. Null for drafts
   * written from employee chat or a mail handover, where no Run is in play.
   * The Drafts review queue reads these to say which Routine produced a draft
   * and to link back to its Run.
   */
  @Column({ type: "varchar", nullable: true })
  createdByRoutineId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByRunId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
