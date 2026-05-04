import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * One line off a bank feed. Phase D of the Finance milestone (M19) —
 * see ROADMAP.md.
 *
 * Positive `amountCents` = money in (deposit). Negative = money out
 * (withdrawal / fee). Stored signed so the auto-match heuristic and
 * reconciliation UI don't have to remember a separate side column.
 *
 * `matchedPaymentId` and `matchedLedgerEntryId` are the two outcomes
 * of a successful match: either the row corresponds to an
 * `InvoicePayment` we already recorded (the common case), or to a
 * `LedgerEntry` (manual entry, future bill payment). At most one is
 * set at a time. `reconciledAt` stamps the moment the human (or
 * auto-matcher) confirmed the match.
 */
@Entity("bank_transactions")
@Index(["feedId"])
@Index(["companyId", "feedId", "date"])
@Index(["companyId", "reconciledAt"])
@Index(["feedId", "externalId"])
export class BankTransaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  feedId!: string;

  /** Provider id (Stripe payout id, etc.) used for dedupe on re-sync.
   *  Null for CSV imports — we dedupe those by `(date, amount,
   *  description)` triple in the import code. */
  @Column({ type: "varchar", nullable: true })
  externalId!: string | null;

  @Column({ type: "datetime" })
  date!: Date;

  @Column({ type: "int" })
  amountCents!: number;

  @Column({ type: "varchar", default: "" })
  description!: string;

  /** Free-form bank-supplied reference number, if any. Stored separately
   *  from `description` so the auto-matcher can score them differently. */
  @Column({ type: "varchar", default: "" })
  reference!: string;

  /** Verbatim provider/CSV row, JSON-stringified, for debug & re-parse. */
  @Column({ type: "text", default: "" })
  raw!: string;

  @Column({ type: "varchar", nullable: true })
  matchedPaymentId!: string | null;

  @Column({ type: "varchar", nullable: true })
  matchedLedgerEntryId!: string | null;

  @Column({ type: "datetime", nullable: true })
  reconciledAt!: Date | null;

  /** Who reconciled this row. Null for auto-matched rows. */
  @Column({ type: "varchar", nullable: true })
  reconciledById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
