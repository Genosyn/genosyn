import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Local mirror of one Gmail conversation. Recomputed from its messages on
 * every sync pass that touches the thread.
 *
 * `labelIds` is the union of the member messages' Gmail label ids, stored
 * as a space-delimited string with leading/trailing spaces (" INBOX UNREAD ")
 * so both sqlite and postgres can answer "threads in folder X" with a plain
 * `LIKE '% INBOX %'` — the codebase deliberately has no relation tables, and
 * a join table for labels would be the odd one out.
 */
@Entity("mail_threads")
@Index(["companyId"])
@Index(["accountId", "lastMessageAt"])
@Index(["accountId", "gmailThreadId"], { unique: true })
export class MailThread {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  gmailThreadId!: string;

  @Column({ type: "varchar", default: "" })
  subject!: string;

  /** Snippet of the newest message, for the list row. */
  @Column({ type: "text", default: "" })
  snippet!: string;

  /** Display string of counterparties, e.g. "Ada Lovelace, billing@acme.com". */
  @Column({ type: "text", default: "" })
  participants!: string;

  /** Space-delimited union of message label ids — see class doc. */
  @Column({ type: "text", default: "" })
  labelIds!: string;

  /** True while any member message still carries UNREAD. */
  @Column({ type: "boolean", default: false })
  unread!: boolean;

  @Column({ type: "int", default: 0 })
  messageCount!: number;

  @Column({ type: "boolean", default: false })
  hasAttachments!: boolean;

  /** internalDate of the newest message — the list sort key. */
  @Column({ type: "datetime", nullable: true })
  lastMessageAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
