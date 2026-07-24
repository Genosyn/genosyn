import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A write-off against an issued invoice. Phase H of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 * A write-off settles part or all of a receivable WITHOUT cash arriving and
 * WITHOUT reversing the original sale — it is deliberately NOT a credit note.
 * Two kinds:
 *   - `bad_debt`  — the debt is uncollectible. Posts DR 6100 Bad Debt Expense
 *     / CR 1200 Accounts Receivable, so the revenue stays recognized in the
 *     period it was earned (a credit note, by contrast, reverses revenue).
 *   - `residual`  — an immaterial short-payment left after settlement (a few
 *     cents of FX drift or a settlement discount). Same postings; the default
 *     expense account can be overridden.
 *
 * Money: `amountCents` is in the invoice's document currency (it caps against
 * the invoice's open balance, which is document-currency). `homeCents` is the
 * converted amount posted on BOTH ledger legs — the two legs use the same rate
 * (the invoice's issue-date rate), so a write-off is always two balanced lines
 * and can never produce an FX gain/loss leg. Both carrying amounts are stored
 * so the reversal can rebuild the exact entry.
 */
export type InvoiceWriteOffKind = "bad_debt" | "residual";

@Entity("invoice_write_offs")
@Index(["companyId"])
@Index(["invoiceId"])
export class InvoiceWriteOff {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  invoiceId!: string;

  @Column({ type: "varchar" })
  kind!: InvoiceWriteOffKind;

  /** Write-off amount in the invoice's document currency. */
  @Column({ type: "int" })
  amountCents!: number;

  /** Converted amount in the company home currency, posted on both legs. */
  @Column({ type: "int" })
  homeCents!: number;

  /** Snapshot of the invoice's document currency at write-off time. */
  @Column({ type: "varchar" })
  currency!: string;

  /** The expense account debited (default 6100 Bad Debt Expense). Stored so
   *  the reversal credits the same account it originally debited. */
  @Column({ type: "varchar" })
  expenseAccountId!: string;

  /** Accounting date of the write-off. */
  @Column({ type: dateTimeColumnType })
  writeOffDate!: Date;

  @Column({ type: "text", default: "" })
  note!: string;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  /** Set when the write-off is reversed (a mistake, or bad-debt recovery). A
   *  reversed write-off no longer counts toward the invoice's settled amount. */
  @Column({ type: dateTimeColumnType, nullable: true })
  reversedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  reversedById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
