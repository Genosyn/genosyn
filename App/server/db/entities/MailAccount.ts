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
 * Which backend speaks for this mailbox.
 *
 * `gmail` drives the Gmail REST API on a `google` Connection — the original
 * and still the best experience where it is available. `imap` drives any
 * IMAP/SMTP server on an `imap` Connection, which is what lets a company on
 * Fastmail, iCloud, Zoho, a corporate Exchange server, or a self-hosted
 * mailbox use the Email section at all, with no OAuth app to register
 * anywhere.
 */
export type MailAccountProvider = "gmail" | "imap";

/**
 * One mailbox connected to the Email section (M25).
 *
 * A MailAccount does not hold credentials of its own — it points at an
 * IntegrationConnection and borrows its credential lifecycle: a `google`
 * Connection whose OAuth consent included the Gmail scope group, or an `imap`
 * Connection holding an address and an app password. Deleting the account
 * removes the local mirror (threads, messages, labels, rules, handovers,
 * grants) but leaves the Connection alone; other surfaces may still use it.
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

  /** The IntegrationConnection whose credentials this mailbox uses. */
  @Column({ type: "varchar" })
  connectionId!: string;

  /**
   * Which backend drives this mailbox. Defaults to `gmail` so every row that
   * existed before IMAP support keeps meaning exactly what it meant.
   */
  @Column({ type: "varchar", default: "gmail" })
  provider!: MailAccountProvider;

  /** The mailbox address, read from the provider at connect time. */
  @Column({ type: "varchar" })
  address!: string;

  @Column({ type: "varchar", default: "active" })
  status!: MailAccountStatus;

  /** Human-readable reason when `status` is `error`. */
  @Column({ type: "varchar", default: "" })
  statusMessage!: string;

  /** Gmail history cursor. Captured at the start of the first backfill.
   * Unused by IMAP mailboxes, which have no equivalent. */
  @Column({ type: "varchar", default: "" })
  historyId!: string;

  /**
   * Per-folder sync state for an IMAP mailbox, as versioned JSON.
   *
   * Kept apart from `historyId` / `backfillPageToken` rather than folded into
   * them because the two engines track genuinely different things: Gmail has
   * one mailbox-wide history cursor, while IMAP has a `UIDVALIDITY` and a
   * high-water UID **per folder**, any one of which the server may invalidate
   * on its own. Empty for a Gmail mailbox. Parsed by
   * `services/mail/imapSync.ts`, which tolerates anything it does not
   * recognise rather than failing a sync on a cursor it cannot read.
   */
  @Column({ type: "text", default: "" })
  syncCursor!: string;

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

  /**
   * Whether an AI Employee reads each newly-arrived message and proposes
   * one-click next steps for it. On by default: a mailbox nobody configured
   * should still arrive useful, and the buttons never act on their own.
   */
  @Column({ type: "boolean", default: true })
  aiAnalysisEnabled!: boolean;

  /**
   * The AI Employee that reads inbound mail here. Null means "whichever
   * granted employee is best placed today" — resolved per message, so the
   * mailbox keeps working after the chosen employee is deleted or loses its
   * model rather than going quietly dark.
   */
  @Column({ type: "varchar", nullable: true })
  aiAnalysisEmployeeId!: string | null;

  /** Pinned brain for the read. Null inherits the employee's active model. */
  @Column({ type: "varchar", nullable: true })
  aiAnalysisModelId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
