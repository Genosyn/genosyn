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
 * A `RecurringInvoice` is an invoice template that fires on a cron schedule
 * to generate a new `Invoice` each cycle (e.g. monthly retainers, annual
 * software licences).
 *
 * It is intentionally a separate primitive from `Invoice` — the generated
 * invoices remain plain `Invoice` rows so the rest of the Finance stack
 * (issuing, sending, ledger posting, reports) needs no special-casing.
 *
 * Status lifecycle:
 *   - `active`  — schedule fires on each due tick. `nextRunAt` set.
 *   - `paused`  — schedule ignored; `nextRunAt` cleared until resumed.
 *   - `ended`   — terminal (max runs reached, endsOn elapsed, or user
 *                  explicitly ended it). `nextRunAt` cleared.
 *
 * On each fire the service layer:
 *   1. Records the due slot as a `RecurringInvoiceRun` and advances
 *      `nextRunAt` from *now*.
 *   2. Materializes a fresh `Invoice` (status `draft` or `sent`
 *      depending on `autoSend`) with line items snapshotted from the
 *      template lines and the schedule's discount, issueDate = now,
 *      dueDate = now + daysUntilDue.
 *   3. Posts ledger entries via the existing `issueInvoice` path when
 *      auto-send is on (or just leaves it as a draft if not).
 *   4. Optionally calls `sendInvoiceEmail` if `autoSend` is true.
 *   5. Increments `runsCreated` and closes the run.
 * The run row carries the slot through crashes and failed steps 2–4: the
 * heartbeat resumes it, retrying with a backoff, and never bills it twice.
 *
 * Catch-up after downtime mirrors `services/cron.ts`: a single fire
 * collapses any missed slots — accountants would rather see one invoice
 * for "this month" than fifty back-dated ones if the server went down.
 */
export type RecurringInvoiceStatus = "active" | "paused" | "ended";

/** The calendar unit a schedule repeats on. Paired with `intervalCount`
 *  ("every N units"). Only consulted when `intervalCount >= 2`; a count of
 *  1 is driven entirely by `cronExpr`. */
export type RecurringInvoiceFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

@Entity("recurring_invoices")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status"])
@Index(["companyId", "customerId"])
@Index(["status", "nextRunAt"])
@Index(["companyId", "archivedAt"])
export class RecurringInvoice {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerId!: string;

  /** Optional legal issuer; null retains the company default. */
  @Column({ type: "varchar", nullable: true })
  subsidiaryId!: string | null;

  /** URL slug — `ri-<short>` at create time; renames keep the slug. */
  @Column({ type: "varchar" })
  slug!: string;

  /** Human label shown in the list, e.g. "Acme Corp". A new schedule takes
   *  its customer's name unless one is given (`shared/recurringInvoiceName.ts`);
   *  changing the customer later never renames it. */
  @Column({ type: "varchar" })
  name!: string;

  /** Cron expression interpreted by `cron-parser` (server local time).
   *  Examples: `0 9 1 * *` (9am on the 1st of each month),
   *  `0 9 * * 1` (every Monday 9am). */
  @Column({ type: "varchar" })
  cronExpr!: string;

  /** Calendar unit the schedule repeats on. Mirrors the cron shape; the
   *  authoritative driver for the cadence when `intervalCount >= 2`, where
   *  cron alone can't express "every N weeks / months". */
  @Column({ type: "varchar", default: "monthly" })
  frequency!: RecurringInvoiceFrequency;

  /** "Every N" multiplier on `frequency`. 1 = every cron occurrence (pure
   *  cron). >= 2 means skip to every Nth unit, measured from `anchorAt`. */
  @Column({ type: "int", default: 1 })
  intervalCount!: number;

  /** Reference instant the interval cadence counts from (the first base cron
   *  occurrence). Null for plain (intervalCount = 1) schedules; seeded by
   *  `registerRecurringInvoice` and re-seeded when the schedule is edited. */
  @Column({ type: dateTimeColumnType, nullable: true })
  anchorAt!: Date | null;

  @Column({ type: "varchar", default: "active" })
  status!: RecurringInvoiceStatus;

  /** Days to set on the generated invoice's `dueDate` (issueDate + N). */
  @Column({ type: "int", default: 14 })
  daysUntilDue!: number;

  /** If true, the heartbeat issues + sends the generated invoice via
   *  the company's `EmailProvider`. Otherwise it lands as a draft. */
  @Column({ type: "boolean", default: false })
  autoSend!: boolean;

  /** ISO 4217 currency for generated invoices. Overrides the customer
   *  default; `recomputeInvoiceTotals` reads this into each child Invoice. */
  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  /** Free-form note copied onto each generated invoice. */
  @Column({ type: "text", default: "" })
  notes!: string;

  /** Free-form footer copied onto each generated invoice. */
  @Column({ type: "text", default: "" })
  footer!: string;

  /** Whole-invoice discount stamped on each generated invoice, as a
   *  percentage (0–100) taken off before tax. Zero when the discount is a
   *  fixed amount or there is none — see `shared/documentDiscount.ts`. */
  @Column({ type: "real", default: 0 })
  discountPercent!: number;

  /** The same discount as a fixed pre-tax amount in minor units. Zero when
   *  it is a percentage or there is none. What it takes off is worked out
   *  per invoice, from the lines that run bills. */
  @Column({ type: "int", default: 0 })
  discountAmountCents!: number;

  /** Next scheduled fire. Null when paused / ended / cron unparseable. */
  @Column({ type: dateTimeColumnType, nullable: true })
  nextRunAt!: Date | null;

  /** Timestamp of the last generation, or null if it hasn't run yet. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastRunAt!: Date | null;

  /** Slug of the last invoice produced by this schedule — handy for the
   *  detail view's "latest run" callout without an extra query. */
  @Column({ type: "varchar", default: "" })
  lastInvoiceSlug!: string;

  /** Number of invoices this schedule has produced. */
  @Column({ type: "int", default: 0 })
  runsCreated!: number;

  /** Optional cap on total runs. `null` = unlimited; once `runsCreated`
   *  reaches this, status auto-flips to `ended`. */
  @Column({ type: "int", nullable: true })
  maxRuns!: number | null;

  /** Optional cutoff date. After this, status auto-flips to `ended`. */
  @Column({ type: dateTimeColumnType, nullable: true })
  endsOn!: Date | null;

  /** Filing, not a status: an archived schedule leaves the default lists and
   *  keeps its cadence, lines, and run history. Only a schedule that has
   *  stopped billing — paused or ended — can be archived
   *  (`shared/invoiceArchive.ts`), and resuming one brings it back
   *  (`applyRecurringInvoiceStatus`), so an archived schedule never bills
   *  anyone. Restoring clears it. */
  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
