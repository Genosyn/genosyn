import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A payment recorded against an `Invoice`. Phase A of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * Sum(payments) drives `Invoice.paidCents` / `Invoice.balanceCents` /
 * status transitions in `services/finance.ts > recomputeInvoiceTotals()`.
 * Deleting a payment recomputes the parent invoice (paid → sent if the
 * remaining payments don't cover the total).
 *
 * `bankTransactionId` is the deposit on Banking this payment arrived in. One
 * deposit can pay several invoices — a customer settling three at once — and
 * a payment is in at most one deposit, which the single column guarantees.
 * Matches made before deposits could pay several invoices live on
 * `BankTransaction.matchedPaymentId` instead (`services/bankPaymentLinks.ts`
 * reads both).
 */
export type InvoicePaymentMethod = "cash" | "bank_transfer" | "stripe" | "lightning" | "other";

@Entity("invoice_payments")
@Index(["invoiceId"])
@Index(["bankTransactionId"])
export class InvoicePayment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  invoiceId!: string;

  @Column({ type: "int" })
  amountCents!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: dateTimeColumnType })
  paidAt!: Date;

  /** The rate into the home currency on the day it was paid, locked when the
   *  payment posts: the cash it brought in is booked at this rate, and the
   *  difference from the invoice's own rate posts as FX gain or loss. 1 in
   *  the home currency; null on a payment recorded before rates were locked,
   *  whose rate is on its ledger entry. */
  @Column({ type: "real", nullable: true })
  exchangeRate!: number | null;

  @Column({ type: "varchar", default: "other" })
  method!: InvoicePaymentMethod;

  /** Free-form external reference — bank txn id, Stripe charge id, etc. */
  @Column({ type: "varchar", default: "" })
  reference!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  /** The bank transaction (a deposit on Banking) this payment arrived in. */
  @Column({ type: "varchar", nullable: true })
  bankTransactionId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
