import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "typeorm";

/**
 * One line on an `Invoice`. Phase A of the Finance milestone (M19) — see
 * ROADMAP.md.
 *
 * Snapshot semantics: `description`, `unitPriceCents`, `taxName`,
 * `taxPercent`, and `taxInclusive` are all snapshotted from the source
 * `Product` / `TaxRate` at line-create time. Editing the product or
 * tax rate later doesn't change this row — accountants need historical
 * invoices to be immutable in this respect.
 *
 * Computed columns (`lineSubtotalCents`, `lineTaxCents`, `lineTotalCents`)
 * are produced by `lib/money.ts > computeLineTotals()` in the service
 * layer; the route never writes them directly.
 */
@Entity("invoice_line_items")
@Index(["invoiceId"])
export class InvoiceLineItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  invoiceId!: string;

  /** Source product, kept as a reference for "rebill same item" UX. Lines
   *  remain valid if the product is later archived or deleted. */
  @Column({ type: "varchar", nullable: true })
  productId!: string | null;

  @Column({ type: "varchar" })
  description!: string;

  /** Quantity is a real to support fractional units (e.g. 2.5 hours). */
  @Column({ type: "real", default: 1 })
  quantity!: number;

  @Column({ type: "int", default: 0 })
  unitPriceCents!: number;

  /** Source tax rate, kept for display only — the snapshotted percent
   *  and inclusive flag below are what totals use. */
  @Column({ type: "varchar", nullable: true })
  taxRateId!: string | null;

  @Column({ type: "varchar", default: "" })
  taxName!: string;

  @Column({ type: "real", default: 0 })
  taxPercent!: number;

  @Column({ type: "boolean", default: false })
  taxInclusive!: boolean;

  @Column({ type: "int", default: 0 })
  lineSubtotalCents!: number;

  @Column({ type: "int", default: 0 })
  lineTaxCents!: number;

  @Column({ type: "int", default: 0 })
  lineTotalCents!: number;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;
}
