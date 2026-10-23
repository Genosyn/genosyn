import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  type ValueTransformer,
} from "typeorm";

/** Postgres hands a bigint back as a string; a balance in cents fits a number exactly. */
const minorUnits: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

/**
 * Source a `BankTransaction` came from. Phase D of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 *   - `stripe_payouts`: pulled from a Stripe `IntegrationConnection` via
 *     /v1/payouts. We dedupe by Stripe id (stored on
 *     `BankTransaction.externalId`).
 *   - `brex_cash`: pulled from a Brex `IntegrationConnection` via the
 *     Transactions API. `externalAccountId` identifies the selected Cash
 *     account.
 *   - `wise_balance`: pulled from a Wise `IntegrationConnection` via the
 *     balance statement. `externalAccountId` is `<profileId>:<balanceId>`,
 *     and only a balance in the home currency can be one
 *     (`services/wiseFeeds.ts`).
 *   - `csv`: humans upload a CSV from their bank. We parse on the server
 *     and stash the raw row under `BankTransaction.raw`.
 *
 * Phase E (multi-currency) will add `currency` to `BankFeed`; for Phase
 * D every feed is in the company's home currency (USD).
 */
export type BankFeedKind = "stripe_payouts" | "brex_cash" | "wise_balance" | "csv";

@Entity("bank_feeds")
@Index(["companyId"])
@Index(["companyId", "archivedAt"])
export class BankFeed {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  kind!: BankFeedKind;

  /** Optional pointer to the `IntegrationConnection` we pull from for
   *  native feeds. Null for CSV feeds. */
  @Column({ type: "varchar", nullable: true })
  connectionId!: string | null;

  /** Provider-side account identifier when one Connection can expose more
   *  than one account. Set for Brex Cash and Wise feeds; null for Stripe
   *  and CSV. */
  @Column({ type: "varchar", nullable: true })
  externalAccountId!: string | null;

  /** The ledger account this feed reconciles against — typically 1100
   *  Bank, but a company with multiple bank accounts will create one
   *  account + one feed per real-world bank account. */
  @Column({ type: "varchar" })
  accountId!: string;

  /**
   * When the last sync that succeeded finished — the last CSV import, for a
   * CSV feed. Also each provider sync's cursor: the next one asks for what
   * was posted since a little before it (`services/reconcile.ts`), so a feed
   * that missed months catches up on all of them.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncAt!: Date | null;

  // ── Sync status (`services/bankingSync.ts`) ──────────────────────────────

  /** When the sync running now started; null while none is. */
  @Column({ type: dateTimeColumnType, nullable: true })
  syncStartedAt!: Date | null;

  /** When the last sync attempt finished, whether or not it succeeded. */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncAttemptAt!: Date | null;

  /** Why the last attempt failed, in plain words; "" when it succeeded. */
  @Column({ type: "varchar", default: "" })
  lastSyncError!: string;

  /** What the provider said, with the HTTP status — the error's details. */
  @Column({ type: "text", default: "" })
  lastSyncErrorDetail!: string;

  /** What kind of failure it was (`FeedSyncErrorKind`), which says what fixes it. */
  @Column({ type: "varchar", default: "" })
  lastSyncErrorKind!: string;

  /** Attempts that have failed in a row; the background sync backs off on it. */
  @Column({ type: "int", default: 0 })
  syncFailureCount!: number;

  /** The earliest the background sync tries again after a failure. */
  @Column({ type: dateTimeColumnType, nullable: true })
  nextSyncAt!: Date | null;

  /** The provider's balance at the last sync, for a feed whose provider reports one. */
  @Column({ type: "bigint", nullable: true, transformer: minorUnits })
  balanceCents!: number | null;

  @Column({ type: "varchar", nullable: true })
  balanceCurrency!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  balanceAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
