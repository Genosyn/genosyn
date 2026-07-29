import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type MailDraftSendBatchStatus = "queued" | "running" | "completed" | "completed_with_errors";

/**
 * One human-approved bulk send from the Drafts review queue.
 *
 * The item list is frozen as JSON when the Member confirms the send. Only one
 * item is eligible at a time; `nextSendAt` is advanced by a random one-to-two
 * minute delay after every attempt. Keeping the cursor in the database makes a
 * long queue survive navigation and process restarts without collapsing the
 * remaining mail into a burst.
 */
@Entity("mail_draft_send_batches")
@Index(["companyId", "createdAt"])
@Index(["accountId", "status"])
export class MailDraftSendBatch {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar", default: "queued" })
  status!: MailDraftSendBatchStatus;

  @Column({ type: "int", default: 0 })
  total!: number;

  @Column({ type: "int", default: 0 })
  sent!: number;

  @Column({ type: "int", default: 0 })
  failed!: number;

  /**
   * Ordered JSON array of `{ draftId, status, errorMessage }` records. A text
   * column is portable across SQLite and Postgres and keeps the whole durable
   * cursor atomic under the batch's scheduler lease.
   */
  @Column({ type: "text", default: "[]" })
  itemsJson!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  nextSendAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
