import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "typeorm";

/**
 * One line on a `Bill`. Phase G of the Finance milestone (M19).
 *
 * Differs from `InvoiceLineItem` in one important way: each line picks
 * an `expenseAccountId` rather than a product. That's the natural
 * accountant model — when you book a bill, you decide which expense
 * bucket each line lands in (rent, utilities, COGS, etc.). The
 * line's debit on bill issue posts to that specific account.
 *
 * Tax snapshot fields mirror `InvoiceLineItem`'s — same compute
 * helper from `lib/money.ts`.
 */
@Entity("bill_line_items")
@Index(["billId"])
export class BillLineItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  billId!: string;

  /** The expense account this line books to. Required at issue time;
   *  drafts may have it null while the user is still building. */
  @Column({ type: "varchar", nullable: true })
  expenseAccountId!: string | null;

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
