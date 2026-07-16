import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type MailAccountStatus = "active" | "paused" | "error";

/**
 * One Gmail mailbox connected to the Email section (M25).
 *
 * A MailAccount does not hold credentials of its own — it points at a
 * `google` IntegrationConnection whose OAuth consent included the Gmail
 * scope group, and borrows that connection's token lifecycle. Deleting the
 * account removes the local mirror (threads, messages, labels, rules,
 * handovers, grants) but leaves the Connection alone; other Google surfaces
 * may still be using it.
 *
 * Sync state lives here: `historyId` is the Gmail history cursor the
 * incremental sync resumes from, `lastSyncAt` drives the heartbeat poller,
 * and `backfilledAt` records that the initial import of the *entire* mailbox
 * completed. `status` is the operator switch — `paused` accounts are skipped
 * by the poller, `error` is set (with `statusMessage`) when a sync fails so
 * the UI can surface it.
 *
 * The first import walks the whole mailbox, which for a large account spans
 * many heartbeat passes. `backfillPageToken` is the resumable cursor into
 * Gmail's `threads.list` pagination (empty when not mid-backfill), and
 * `backfilledCount` is the running total of threads imported so far, shown
 * as progress. Once pagination is exhausted, `backfilledAt` is stamped and
 * sync switches to the incremental history API.
 */
@Entity("mail_accounts")
@Index(["companyId"])
@Index(["connectionId"], { unique: true })
export class MailAccount {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The `google` IntegrationConnection whose token this mailbox uses. */
  @Column({ type: "varchar" })
  connectionId!: string;

  /** The Gmail address, from `users.getProfile` at connect time. */
  @Column({ type: "varchar" })
  address!: string;

  @Column({ type: "varchar", default: "active" })
  status!: MailAccountStatus;

  /** Human-readable reason when `status` is `error`. */
  @Column({ type: "varchar", default: "" })
  statusMessage!: string;

  /** Gmail history cursor. Captured at the start of the first backfill. */
  @Column({ type: "varchar", default: "" })
  historyId!: string;

  @Column({ type: "datetime", nullable: true })
  lastSyncAt!: Date | null;

  /** Set once the entire mailbox has been imported. */
  @Column({ type: "datetime", nullable: true })
  backfilledAt!: Date | null;

  /** Resumable `threads.list` page cursor while the full backfill is in
   * flight. Empty when not mid-backfill. */
  @Column({ type: "varchar", default: "" })
  backfillPageToken!: string;

  /** Threads imported by the backfill so far — surfaced as progress. */
  @Column({ type: "int", default: 0 })
  backfilledCount!: number;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
