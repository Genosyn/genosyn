import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Where this ledger entry came from. The auto-post hooks in
 * `services/finance.ts` set `source` + `sourceRefId` so we can:
 *   1. Avoid double-posting (idempotency check before creating).
 *   2. Find every entry tied to an invoice when voiding it (the
 *      `invoice_void` source then writes reversing entries pointing
 *      back at the invoice id).
 *   3. Render the source row alongside each entry in the journal
 *      list so accountants can drill back to the invoice / payment
 *      that produced it.
 *
 * `manual` is the only source a human can write directly through the
 * UI. The auto-post sources are write-only from the service layer.
 *
 * Named **LedgerEntry** rather than the accountant-natural
 * "JournalEntry" because the codebase already has a different
 * `JournalEntry` for per-employee diary feeds (`AIEmployee` →
 * `JournalEntry`). The product surfaces "Journal" / "Journal entries"
 * in copy; only the entity class avoids the collision.
 */
export type LedgerEntrySource =
  | "manual"
  | "invoice_issue"
  | "invoice_payment"
  | "invoice_void";

/**
 * A balanced double-entry transaction. Phase B of the Finance milestone
 * (M19) — see ROADMAP.md. Each `LedgerEntry` has one or more
 * `LedgerLine` children whose `sum(debits) === sum(credits)`. The
 * service layer enforces the balance check; the database does not (no
 * DB-level trigger, since we want the same rule on both sqlite and
 * postgres).
 */
@Entity("ledger_entries")
@Index(["companyId", "date"])
@Index(["companyId", "source", "sourceRefId"])
export class LedgerEntry {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Accounting date — when the transaction *happened*, not when it was
   *  recorded. Reports filter on this; `createdAt` is for audit only. */
  @Column({ type: "datetime" })
  date!: Date;

  @Column({ type: "varchar", default: "" })
  memo!: string;

  @Column({ type: "varchar", default: "manual" })
  source!: LedgerEntrySource;

  /** ID of the source record — `Invoice.id` for invoice_issue /
   *  invoice_void, `InvoicePayment.id` for invoice_payment, null for
   *  manual entries. Indexed with `source` so reversal lookups are O(1). */
  @Column({ type: "varchar", nullable: true })
  sourceRefId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
