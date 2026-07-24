import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * One line on a `VendorCredit`. Phase H of the Finance milestone (M19). Mirrors
 * `BillLineItem`: each line carries the `expenseAccountId` it credits back, so
 * a credit raised "in full" from a bill reverses each line's expense to the
 * exact account it was originally booked to.
 */
@Entity("vendor_credit_lines")
@Index(["creditId"])
export class VendorCreditLine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  creditId!: string;

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

  /** Home-currency subtotal posted (CR expense) for this line at issue, stored
   *  so a void re-debits each expense account by the exact original amount. */
  @Column({ type: "int", default: 0 })
  homeSubtotalCents!: number;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;
}
