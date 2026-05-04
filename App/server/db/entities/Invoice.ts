import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Invoice statuses for Phase A of the Finance milestone (M19).
 *
 * - `draft`  — fully editable, deletable. Has a `numberSeq` of 0 and no
 *              display number until issued.
 * - `sent`   — locked (line items immutable). Number minted at issue.
 *              Payments may be recorded; voiding is allowed.
 * - `paid`   — `paidCents >= totalCents`. Same as `sent` for editing
 *              rules; transitions back to `sent` if a payment is deleted.
 * - `void`   — terminal. Cannot be edited or deleted.
 *
 * "Overdue" is computed at read-time from `dueDate` + status, not stored,
 * so flipping the system clock or extending the due date can't leave
 * invoices in an inconsistent state.
 */
export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

/**
 * An Invoice is a billable document issued to a `Customer`. Phase A of
 * the Finance milestone (M19) — see ROADMAP.md.
 *
 * Numbering: `numberSeq` is a per-company gapless integer minted at
 * issue (transition draft → sent). Drafts carry `numberSeq = 0` and
 * `number = ""`. Display format is `INV-0001`; format is owned by
 * `lib/money.ts > formatInvoiceNumber()`.
 *
 * Cent columns (`subtotalCents`, `taxCents`, `totalCents`, `paidCents`,
 * `balanceCents`) are recomputed by the service layer from the lines +
 * payments. The route layer never writes them directly.
 */
@Entity("invoices")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status"])
@Index(["companyId", "customerId"])
@Index(["companyId", "numberSeq"])
export class Invoice {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerId!: string;

  /** URL slug — `inv-0001` once issued, `draft-<short>` while in draft.
   *  Renames don't change the slug; voiding doesn't either. */
  @Column({ type: "varchar" })
  slug!: string;

  /** Gapless per-company sequence. `0` until the invoice is issued. */
  @Column({ type: "int", default: 0 })
  numberSeq!: number;

  /** Display string — e.g. `INV-0001`. Empty while in draft. */
  @Column({ type: "varchar", default: "" })
  number!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: InvoiceStatus;

  @Column({ type: "datetime" })
  issueDate!: Date;

  @Column({ type: "datetime" })
  dueDate!: Date;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "int", default: 0 })
  subtotalCents!: number;

  @Column({ type: "int", default: 0 })
  taxCents!: number;

  @Column({ type: "int", default: 0 })
  totalCents!: number;

  @Column({ type: "int", default: 0 })
  paidCents!: number;

  /** `totalCents - paidCents`. Stored so list views can sort/filter on it
   *  without recomputing. */
  @Column({ type: "int", default: 0 })
  balanceCents!: number;

  /** Free-form note shown on the invoice (above the totals). */
  @Column({ type: "text", default: "" })
  notes!: string;

  /** Free-form footer (payment terms, bank details, thank-you note). */
  @Column({ type: "text", default: "" })
  footer!: string;

  @Column({ type: "datetime", nullable: true })
  sentAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  paidAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  voidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
