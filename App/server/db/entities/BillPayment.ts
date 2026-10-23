import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A payment we made against a `Bill`. Phase G of the Finance milestone
 * (M19). Mirrors `InvoicePayment` — same lifecycle, same auto-post
 * behavior (DR Accounts Payable / CR Bank instead of DR Bank / CR AR).
 */
export type BillPaymentMethod = "cash" | "bank_transfer" | "stripe" | "lightning" | "other";

@Entity("bill_payments")
@Index(["billId"])
export class BillPayment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  billId!: string;

  @Column({ type: "int" })
  amountCents!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: dateTimeColumnType })
  paidAt!: Date;

  /** The rate into the home currency on the day it was paid, locked when the
   *  payment posts, as on `InvoicePayment`. Null on a payment recorded before
   *  rates were locked. */
  @Column({ type: "real", nullable: true })
  exchangeRate!: number | null;

  @Column({ type: "varchar", default: "other" })
  method!: BillPaymentMethod;

  @Column({ type: "varchar", default: "" })
  reference!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
