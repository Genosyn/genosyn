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
 * Where a card's transactions come from: `brex_card` reads a Brex Connection's
 * card transactions, `ramp_card` a Ramp Connection's card transactions and the
 * payments made against its balance (`services/cardExpenses.ts`).
 */
export type CardFeedKind = "brex_card" | "ramp_card";

/**
 * One provider-backed corporate card account mapped into the ledger.
 * Purchases credit the liability account and debit the selected expense
 * account; statement collections debit the liability and credit the
 * configured payment account.
 */
@Entity("card_feeds")
@Index(["companyId"])
@Index(["companyId", "archivedAt"])
export class CardFeed {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  kind!: CardFeedKind;

  @Column({ type: "varchar" })
  connectionId!: string;

  @Column({ type: "varchar" })
  liabilityAccountId!: string;

  @Column({ type: "varchar" })
  defaultExpenseAccountId!: string;

  @Column({ type: "varchar" })
  paymentAccountId!: string;

  /**
   * When the last sync that succeeded finished, and the next sync's cursor:
   * it asks the provider for what was posted since a little before it
   * (`services/cardExpenses.ts`).
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncAt!: Date | null;

  // ── Sync status (`services/bankingSync.ts`), as on `BankFeed` ────────────

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

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
