import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * A vendor credit — the AP mirror of `CustomerCredit`. Phase H of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * When a supplier issues us a credit, we're owed value back. It NEVER touches
 * 2200 Accounts Payable on issue; it parks in 1300 Vendor Credits (an asset —
 * the supplier owes us). Issue posts DR 1300 / CR <each line's expense
 * account> / CR 2100 Tax Payable, reversing the original bill's expense and
 * input tax. The credit is spent by an application against a bill we owe
 * (DR 2200 / CR 1300) or a cash refund from the supplier (DR 1100 / CR 1300).
 *
 * `openCents` = totalCents − appliedCents − refundedCents. The `home*` columns
 * are the home-currency carrying amounts posted at issue.
 */
export type VendorCreditStatus = "draft" | "issued" | "void";

@Entity("vendor_credits")
@Index(["companyId"])
@Index(["companyId", "vendorId"])
@Index(["companyId", "sourceBillId"])
@Index(["companyId", "slug"], { unique: true })
export class VendorCredit {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  vendorId!: string;

  @Column({ type: "varchar", default: "issued" })
  status!: VendorCreditStatus;

  @Column({ type: "int", default: 0 })
  numberSeq!: number;

  @Column({ type: "varchar", default: "" })
  number!: string;

  @Column({ type: "varchar" })
  slug!: string;

  /** The bill this credit was raised from, if any. */
  @Column({ type: "varchar", nullable: true })
  sourceBillId!: string | null;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "int", default: 0 })
  subtotalCents!: number;

  @Column({ type: "int", default: 0 })
  taxCents!: number;

  @Column({ type: "int", default: 0 })
  totalCents!: number;

  @Column({ type: "int", default: 0 })
  homeSubtotalCents!: number;

  @Column({ type: "int", default: 0 })
  homeTaxCents!: number;

  @Column({ type: "int", default: 0 })
  homeTotalCents!: number;

  @Column({ type: "int", default: 0 })
  appliedCents!: number;

  @Column({ type: "int", default: 0 })
  homeAppliedCents!: number;

  @Column({ type: "int", default: 0 })
  refundedCents!: number;

  @Column({ type: "int", default: 0 })
  homeRefundedCents!: number;

  @Column({ type: "text", default: "" })
  reason!: string;

  @Column({ type: "text", default: "" })
  notes!: string;

  @Column({ type: dateTimeColumnType })
  issueDate!: Date;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  issuedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  voidedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
