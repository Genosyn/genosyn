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
 * Source a `BankTransaction` came from. Phase D of the Finance milestone
 * (M19) — see ROADMAP.md.
 *
 *   - `stripe_payouts`: pulled from a Stripe `IntegrationConnection` via
 *     /v1/payouts. We dedupe by Stripe id (stored on
 *     `BankTransaction.externalId`).
 *   - `brex_cash`: pulled from a Brex `IntegrationConnection` via the
 *     Transactions API. `externalAccountId` identifies the selected Cash
 *     account.
 *   - `csv`: humans upload a CSV from their bank. We parse on the server
 *     and stash the raw row under `BankTransaction.raw`.
 *
 * Phase E (multi-currency) will add `currency` to `BankFeed`; for Phase
 * D every feed is in the company's home currency (USD).
 */
export type BankFeedKind = "stripe_payouts" | "brex_cash" | "csv";

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
   *  than one account. Set for Brex Cash feeds; null for Stripe and CSV. */
  @Column({ type: "varchar", nullable: true })
  externalAccountId!: string | null;

  /** The ledger account this feed reconciles against — typically 1100
   *  Bank, but a company with multiple bank accounts will create one
   *  account + one feed per real-world bank account. */
  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
