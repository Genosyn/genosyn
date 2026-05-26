import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Estimate (also called Quotation) statuses.
 *
 * - `draft`     — fully editable, deletable. `numberSeq` is 0 and no
 *                  display number until issued.
 * - `sent`      — locked (line items immutable). Number minted at issue.
 *                  Customer-facing; can be accepted, declined, voided, or
 *                  converted to an invoice.
 * - `accepted`  — customer has accepted. Can still be converted to an
 *                  invoice (the common path) or voided.
 * - `declined`  — customer has declined. Terminal.
 * - `void`      — terminal. Cannot be edited or deleted.
 *
 * "Expired" is computed at read-time from `validUntil` + status, not
 * stored, so adjusting the validity window can't leave estimates in an
 * inconsistent state.
 *
 * Estimates intentionally do *not* post to the general ledger — they are
 * pre-sale documents, not financial transactions. The journal posting
 * happens only when an accepted estimate is converted to an Invoice.
 */
export type EstimateStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "declined"
  | "void";

/**
 * An Estimate is a quotation issued to a `Customer` before a sale is
 * finalized. Mirrors the shape of `Invoice` minus payments/balance —
 * estimates carry no money, just proposed line items.
 *
 * Numbering: `numberSeq` is a per-company gapless integer minted at
 * issue (transition draft → sent). Drafts carry `numberSeq = 0` and
 * `number = ""`. Display format is `EST-0001`; format is owned by
 * `lib/money.ts > formatEstimateNumber()`.
 *
 * Cent columns (`subtotalCents`, `taxCents`, `totalCents`) are
 * recomputed by the service layer from the lines. The route layer
 * never writes them directly.
 */
@Entity("estimates")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status"])
@Index(["companyId", "customerId"])
@Index(["companyId", "numberSeq"])
export class Estimate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerId!: string;

  /** URL slug — `est-0001` once issued, `edraft-<short>` while in draft.
   *  Renames don't change the slug; voiding doesn't either. */
  @Column({ type: "varchar" })
  slug!: string;

  /** Gapless per-company sequence. `0` until the estimate is issued. */
  @Column({ type: "int", default: 0 })
  numberSeq!: number;

  /** Display string — e.g. `EST-0001`. Empty while in draft. */
  @Column({ type: "varchar", default: "" })
  number!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: EstimateStatus;

  @Column({ type: "datetime" })
  issueDate!: Date;

  /** The day this quote stops being valid. Past `validUntil` + status
   *  `sent` is rendered as "expired" in the UI without changing the
   *  stored status. */
  @Column({ type: "datetime" })
  validUntil!: Date;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "int", default: 0 })
  subtotalCents!: number;

  @Column({ type: "int", default: 0 })
  taxCents!: number;

  @Column({ type: "int", default: 0 })
  totalCents!: number;

  /** Free-form note shown on the estimate (above the totals). */
  @Column({ type: "text", default: "" })
  notes!: string;

  /** Free-form footer (terms, contact details, thank-you note). */
  @Column({ type: "text", default: "" })
  footer!: string;

  @Column({ type: "datetime", nullable: true })
  sentAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  declinedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  voidedAt!: Date | null;

  /** Set when this estimate has been converted to an invoice. The UI
   *  presents this as a synthetic "invoiced" badge and links to the
   *  invoice; the stored status stays at `accepted` (or whatever it
   *  was at conversion time). */
  @Column({ type: "varchar", nullable: true })
  invoiceId!: string | null;

  @Column({ type: "datetime", nullable: true })
  convertedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
