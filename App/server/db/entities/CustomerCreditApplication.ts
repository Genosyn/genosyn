import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Application of a `CustomerCredit` against an `Invoice`. Phase H of the
 * Finance milestone (M19) — see ROADMAP.md.
 *
 * This is the ONLY row type that clears a receivable without cash. It posts
 * DR 2400/2500 (the credit's account) / CR 1200 Accounts Receivable, plus a
 * bounded FX plug when the credit's carrying rate differs from the rate the
 * invoice's AR was booked at. `amountCents` is hard-capped at
 * min(credit.openCents, invoice.balanceCents), both document currency, and a
 * credit may only be applied to an invoice in the SAME currency — so a
 * negative receivable and a cross-currency balance are both structurally
 * unreachable.
 *
 * Carrying columns (`arCents`, `creditCents`, `fxCents`) record the exact home
 * legs posted, so an unapply rebuilds a precise mirror. `fxCents` is signed:
 * > 0 posted a 4910 FX Gain credit, < 0 posted a 6900 FX Loss debit.
 */
@Entity("customer_credit_applications")
@Index(["companyId"])
@Index(["creditId"])
@Index(["invoiceId"])
export class CustomerCreditApplication {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  creditId!: string;

  @Column({ type: "varchar" })
  invoiceId!: string;

  /** Amount applied, in the shared document currency of the credit + invoice. */
  @Column({ type: "int" })
  amountCents!: number;

  /** Home-currency AR relieved (CR 1200), at the invoice's issue-date rate. */
  @Column({ type: "int" })
  arCents!: number;

  /** Home-currency credit consumed (DR 2400/2500), the credit's carrying share. */
  @Column({ type: "int" })
  creditCents!: number;

  /** Signed home FX plug: creditCents − arCents. >0 ⇒ 4910 gain, <0 ⇒ 6900 loss. */
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
