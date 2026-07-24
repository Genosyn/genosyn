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
 * A customer credit. Phase H of the Finance milestone (M19) — see ROADMAP.md.
 *
 * A credit is money we owe a customer, or unearned money they've paid us. It
 * NEVER touches 1200 Accounts Receivable on issue — that is what makes a
 * negative receivable structurally unreachable. Three kinds:
 *
 *   - `credit_memo` — reduces a past sale. Issue posts DR 4100 Sales Returns &
 *     Allowances / DR 2100 Tax Payable / CR 2400 Customer Credits. It is a
 *     numbered document (like an invoice) with line items. It can be raised
 *     from a specific invoice (`sourceInvoiceId`) or stand alone on account.
 *   - `deposit` — a prepayment/retainer taken before any invoice exists. Issue
 *     posts DR 1100 Bank / CR 2500 Customer Deposits (unearned revenue, no tax
 *     leg — correct for US sales tax). Added in Increment 5.
 *   - `overpayment` — the excess when a customer pays more than an invoice's
 *     balance. Posts DR 1100 Bank / CR 2400 Customer Credits. Added in
 *     Increment 5.
 *
 * A credit is spent by a `CustomerCreditApplication` (relieves a receivable,
 * no cash) or a `CustomerRefund` (cash back). `openCents` =
 * totalCents − appliedCents − refundedCents.
 *
 * Money: document amounts are in `currency`; the `home*` columns are the
 * home-currency carrying amounts posted at issue, kept so a void or an
 * application/refund can rebuild exact, balanced entries and split rounding
 * deterministically.
 */
export type CustomerCreditKind = "credit_memo" | "deposit" | "overpayment";
export type CustomerCreditStatus = "draft" | "issued" | "void";

@Entity("customer_credits")
@Index(["companyId"])
@Index(["companyId", "customerId"])
@Index(["companyId", "sourceInvoiceId"])
@Index(["companyId", "slug"], { unique: true })
export class CustomerCredit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  customerId!: string;

  @Column({ type: "varchar" })
  kind!: CustomerCreditKind;

  @Column({ type: "varchar", default: "draft" })
  status!: CustomerCreditStatus;

  /** Gapless per-customer number, minted at issue (e.g. `CN-0001`). Empty
   *  until issued. */
  @Column({ type: "int", default: 0 })
  numberSeq!: number;

  @Column({ type: "varchar", default: "" })
  number!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** The invoice a credit_memo was raised from, if any. Null for on-account
   *  memos, deposits and overpayments. */
  @Column({ type: "varchar", nullable: true })
  sourceInvoiceId!: string | null;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "int", default: 0 })
  subtotalCents!: number;

  @Column({ type: "int", default: 0 })
  taxCents!: number;

  @Column({ type: "int", default: 0 })
  totalCents!: number;

  /** Home-currency carrying amounts posted at issue. subtotal + tax === total
   *  (reconciled), so a void mirrors the issue entry exactly. */
  @Column({ type: "int", default: 0 })
  homeSubtotalCents!: number;

  @Column({ type: "int", default: 0 })
  homeTaxCents!: number;

  @Column({ type: "int", default: 0 })
  homeTotalCents!: number;

  /** Sum of non-reversed applications, document currency. */
  @Column({ type: "int", default: 0 })
  appliedCents!: number;

  /** Home-currency sum of non-reversed application credit-legs. Lets the
   *  last application draw the exact remaining home balance. */
  @Column({ type: "int", default: 0 })
  homeAppliedCents!: number;

  /** Sum of non-reversed refunds, document currency (Increment 5). */
  @Column({ type: "int", default: 0 })
  refundedCents!: number;

  @Column({ type: "int", default: 0 })
  homeRefundedCents!: number;

  @Column({ type: "text", default: "" })
  reason!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: dateTimeColumnType })
  issueDate!: Date;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  issuedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  voidedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
