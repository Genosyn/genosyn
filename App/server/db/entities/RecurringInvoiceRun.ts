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
 * Lifecycle of one scheduled occurrence of a `RecurringInvoice`:
 *   - `pending`   — claimed and not yet finished; the heartbeat keeps
 *                   working it (resuming after a crash, retrying after an
 *                   error) until it reaches one of the states below.
 *   - `succeeded` — the invoice exists and, for auto-send schedules, was
 *                   issued and emailed.
 *   - `failed`    — the invoice was issued but every email attempt failed.
 *                   The invoice stands; a Member sends it by hand.
 *   - `cancelled` — the schedule was paused, ended, or deleted (or the
 *                   generated draft was deleted) before the run finished.
 */
export type RecurringInvoiceRunStatus = "pending" | "succeeded" | "failed" | "cancelled";

/**
 * One scheduled occurrence of a `RecurringInvoice`, written *before* any
 * work starts so the occurrence survives a crash or restart.
 *
 * This row is what makes generation effectively-once:
 *   - `(recurringInvoiceId, scheduledFor)` is unique, so an occurrence is
 *     claimed once no matter how many times the heartbeat sees it due;
 *   - `invoiceId` is set in the same transaction that creates the invoice,
 *     so a resumed run continues that invoice instead of billing again;
 *   - `lockedUntil` holds the run for one worker at a time and lapses on its
 *     own if that worker dies mid-attempt.
 *
 * Run state lives here rather than on `RecurringInvoice` so that editing a
 * schedule (which saves the whole row) can never overwrite a run's progress.
 */
@Entity("recurring_invoice_runs")
@Index(["recurringInvoiceId", "scheduledFor"], { unique: true })
@Index(["status"])
@Index(["companyId"])
export class RecurringInvoiceRun {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  recurringInvoiceId!: string;

  /** The schedule slot this run bills — the `nextRunAt` it was claimed at. */
  @Column({ type: dateTimeColumnType })
  scheduledFor!: Date;

  @Column({ type: "varchar", default: "pending" })
  status!: RecurringInvoiceRunStatus;

  /** The invoice this run generated, once it exists. */
  @Column({ type: "varchar", nullable: true })
  invoiceId!: string | null;

  /** Attempts started, including the one in progress. */
  @Column({ type: "int", default: 0 })
  attempts!: number;

  /** Failed email attempts. Bounded, unlike generation retries. */
  @Column({ type: "int", default: 0 })
  emailAttempts!: number;

  /** "" until an email is attempted, then the last send outcome. */
  @Column({ type: "varchar", default: "" })
  emailStatus!: "" | "sent" | "skipped" | "failed";

  /** Earliest time the heartbeat retries a failed attempt. */
  @Column({ type: dateTimeColumnType, nullable: true })
  retryAt!: Date | null;

  /** Set while one worker holds the run; a lapsed value means it died. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lockedUntil!: Date | null;

  /** Why the last attempt failed, or why the run ended unfinished. */
  @Column({ type: "text", default: "" })
  lastError!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
