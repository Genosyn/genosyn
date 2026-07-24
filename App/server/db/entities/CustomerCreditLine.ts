import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * One line on a `CustomerCredit` of kind `credit_memo`. Phase H of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * Mirrors `InvoiceLineItem` exactly (same tax-snapshot semantics, same
 * computed columns from `lib/money.ts > computeLineTotals()`), so a credit memo
 * raised "in full" from an invoice is a verbatim copy of that invoice's lines
 * and its subtotal/tax/total reconcile line-for-line.
 */
@Entity("customer_credit_lines")
@Index(["creditId"])
export class CustomerCreditLine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  creditId!: string;

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
