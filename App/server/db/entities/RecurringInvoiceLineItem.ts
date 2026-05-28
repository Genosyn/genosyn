import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "typeorm";

/**
 * Template line for a `RecurringInvoice`. Cloned (and tax-snapshotted)
 * onto each generated `Invoice` at fire time.
 *
 * Unlike `InvoiceLineItem`, this row stores no computed totals — they're
 * derived at generation time so editing the template never silently
 * mutates historical invoices.
 */
@Entity("recurring_invoice_line_items")
@Index(["recurringInvoiceId"])
export class RecurringInvoiceLineItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  recurringInvoiceId!: string;

  @Column({ type: "varchar", nullable: true })
  productId!: string | null;

  @Column({ type: "varchar" })
  description!: string;

  @Column({ type: "real", default: 1 })
  quantity!: number;

  @Column({ type: "int", default: 0 })
  unitPriceCents!: number;

  @Column({ type: "varchar", nullable: true })
  taxRateId!: string | null;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;
}
