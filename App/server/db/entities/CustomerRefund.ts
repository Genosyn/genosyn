import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A cash refund of a `CustomerCredit`. Phase H of the Finance milestone (M19)
 * — see ROADMAP.md.
 *
 * This is the ONLY row type that credits 1100 Bank on the AR side. It posts
 * DR 2400/2500 (the credit's account) / CR 1100 Bank, plus a bounded FX plug
 * when the credit's carrying rate differs from the refund-date rate.
 * `amountCents` is capped at the credit's open balance (document currency).
 *
 * Carrying columns (`creditCents`, `bankCents`, `fxCents`) record the exact
 * home legs so a void rebuilds a precise mirror. `fxCents` is signed:
 * > 0 posted a 4910 FX Gain credit, < 0 posted a 6900 FX Loss debit.
 */
@Entity("customer_refunds")
@Index(["companyId"])
@Index(["creditId"])
export class CustomerRefund {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  creditId!: string;

  /** Refund amount in the credit's document currency. */
  @Column({ type: "int" })
  amountCents!: number;

  /** Home-currency credit consumed (DR 2400/2500). */
  @Column({ type: "int" })
  creditCents!: number;

  /** Home-currency cash paid out (CR 1100), at the refund-date rate. */
  @Column({ type: "int" })
  bankCents!: number;

  /** Signed home FX plug: creditCents − bankCents. >0 ⇒ 4910 gain, <0 ⇒ 6900 loss. */
  @Column({ type: "int", default: 0 })
  fxCents!: number;

  @Column({ type: "varchar" })
  currency!: string;

  /** The asset account the cash left from (default 1100 Bank). */
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
