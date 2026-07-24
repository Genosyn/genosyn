import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Application of a `VendorCredit` against a `Bill` — the AP mirror of
 * `CustomerCreditApplication`. Phase H of the Finance milestone (M19).
 *
 * Posts DR 2200 Accounts Payable (reduce what we owe) / CR 1300 Vendor Credits
 * (consume the asset), plus a bounded FX plug. `amountCents` is capped at
 * min(credit open, bill balance), both document currency, and the credit and
 * bill must share a currency — so AP can't be driven negative.
 *
 * `fxCents` is signed: creditCents − apCents. >0 posted a 6900 FX Loss debit,
 * <0 posted a 4910 FX Gain credit (opposite of the AR side, because the parking
 * account here is an asset rather than a liability).
 */
@Entity("vendor_credit_applications")
@Index(["companyId"])
@Index(["creditId"])
@Index(["billId"])
export class VendorCreditApplication {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  creditId!: string;

  @Column({ type: "varchar" })
  billId!: string;

  @Column({ type: "int" })
  amountCents!: number;

  /** Home-currency AP relieved (DR 2200), at the bill's issue-date rate. */
  @Column({ type: "int" })
  apCents!: number;

  /** Home-currency credit consumed (CR 1300), the credit's carrying share. */
  @Column({ type: "int" })
  creditCents!: number;

  /** Signed home FX plug: creditCents − apCents. >0 ⇒ 6900 loss, <0 ⇒ 4910 gain. */
  @Column({ type: "int", default: 0 })
  fxCents!: number;

  @Column({ type: dateTimeColumnType })
  appliedAt!: Date;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  reversedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  reversedById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
