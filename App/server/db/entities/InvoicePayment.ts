import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A payment recorded against an `Invoice`. Phase A of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * Sum(payments) drives `Invoice.paidCents` / `Invoice.balanceCents` /
 * status transitions in `services/finance.ts > recomputeInvoiceTotals()`.
 * Deleting a payment recomputes the parent invoice (paid → sent if the
 * remaining payments don't cover the total).
 *
 * Phase D (Reconciliation) wires `BankTransaction.id` onto the optional
 * `reference` field so a bank-feed match can be unwound by deleting the
 * payment row.
 */
export type InvoicePaymentMethod =
  | "cash"
  | "bank_transfer"
  | "stripe"
  | "lightning"
  | "other";

@Entity("invoice_payments")
@Index(["invoiceId"])
export class InvoicePayment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  invoiceId!: string;

  @Column({ type: "int" })
  amountCents!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "datetime" })
  paidAt!: Date;

  @Column({ type: "varchar", default: "other" })
  method!: InvoicePaymentMethod;

  /** Free-form external reference — bank txn id, Stripe charge id, etc. */
  @Column({ type: "varchar", default: "" })
  reference!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
