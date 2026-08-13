import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type MailAccountStatus = "active" | "paused" | "error";
export type MailSyncState = "idle" | "queued" | "running" | "succeeded" | "failed";

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
 * many heartbeat passes. `backfillPageToken` stores a versioned cursor with
 * the Gmail page token plus the exact remaining thread ids (legacy rows may
 * still contain a plain page token), and `backfilledCount` is the running
 * total shown as progress. Once pagination is exhausted, `backfilledAt` is
 * stamped and sync switches to the incremental history API.
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

  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncAt!: Date | null;

  /** Durable lifecycle for the current/latest sync pass. This is separate
   * from `status`, which remains the operator's active/paused switch plus the
   * mailbox health summary. The UI follows this state rather than guessing
   * from a timestamp, so a failed or recovered pass always terminates. */
  @Column({ type: "varchar", default: "idle" })
  syncState!: MailSyncState;

  /** Random id returned by a manual sync request. Concurrent requests
   * coalesce onto the same pass and observe the same id. */
  @Column({ type: "varchar", nullable: true })
  syncAttemptId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  syncStartedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  syncFinishedAt!: Date | null;

  /** Set once the entire mailbox has been imported. */
  @Column({ type: dateTimeColumnType, nullable: true })
  backfilledAt!: Date | null;

  /** Versioned resumable worklist while the full backfill is in flight.
   * Empty when not mid-backfill; plain legacy Gmail page tokens are accepted. */
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
