import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A cash refund FROM a supplier against a `VendorCredit` — the AP mirror of
 * `CustomerRefund`. Phase H of the Finance milestone (M19).
 *
 * The supplier pays us back, so cash comes IN: posts DR 1100 Bank / CR 1300
 * Vendor Credits, plus a bounded FX plug. Capped at the credit's open balance.
 * `fxCents` is signed: creditCents − bankCents. >0 ⇒ 6900 loss, <0 ⇒ 4910 gain.
 */
@Entity("vendor_refunds")
@Index(["companyId"])
@Index(["creditId"])
export class VendorRefund {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  creditId!: string;

  @Column({ type: "int" })
  amountCents!: number;

  /** Home-currency credit consumed (CR 1300). */
  @Column({ type: "int" })
  creditCents!: number;

  /** Home-currency cash received (DR 1100), at the refund-date rate. */
  @Column({ type: "int" })
  bankCents!: number;

  @Column({ type: "int", default: 0 })
  fxCents!: number;

  @Column({ type: "varchar" })
  currency!: string;

  /** The asset account the cash landed in (default 1100 Bank). */
  @Column({ type: "varchar" })
  bankAccountId!: string;

  @Column({ type: dateTimeColumnType })
  refundedAt!: Date;

  @Column({ type: "varchar", default: "" })
  method!: string;

  @Column({ type: "varchar", default: "" })
  reference!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  reversedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  reversedById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
