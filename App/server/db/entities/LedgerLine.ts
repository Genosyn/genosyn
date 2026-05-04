import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "typeorm";

/**
 * One leg of a `LedgerEntry`. Phase B of the Finance milestone (M19) —
 * see ROADMAP.md.
 *
 * Exactly one of `debitCents` / `creditCents` is non-zero on a given
 * row. The balance check (`sum(debits) === sum(credits)` per
 * `ledgerEntryId`) lives in `services/ledger.ts > postLedgerEntry()`
 * and `reverseLedgerEntriesForSource()` — the database deliberately
 * does not enforce it (would need a CHECK constraint that differs
 * across sqlite/postgres).
 *
 * Currency is intentionally **not** on this row in Phase B — every
 * ledger line is in the company's home currency (USD for now). Phase E
 * (multi-currency) will introduce per-line FX bookkeeping with
 * realized/unrealized gain accounts.
 */
@Entity("ledger_lines")
@Index(["ledgerEntryId"])
@Index(["accountId"])
@Index(["companyId", "accountId"])
export class LedgerLine {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  ledgerEntryId!: string;

  /** Denormalized from the parent so trial-balance / reports queries
   *  can scope by company without a join through `ledger_entries`. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "int", default: 0 })
  debitCents!: number;

  @Column({ type: "int", default: 0 })
  creditCents!: number;

  @Column({ type: "varchar", default: "" })
  description!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  /** Multi-currency audit (Phase E). When the source transaction was
   *  in a foreign currency, these capture the pre-conversion picture:
   *  the original currency code, the original amount in cents (signed
   *  the same way as debit-credit), and the FX rate used to convert
   *  to home. Empty / 0 / 0 mean "no conversion happened". */
  @Column({ type: "varchar", default: "" })
  origCurrency!: string;

  @Column({ type: "int", default: 0 })
  origAmountCents!: number;

  @Column({ type: "real", default: 0 })
  rate!: number;
}
