import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type CardAccountingKind = "expense" | "refund" | "payment";

/**
 * A settled corporate-card transaction. The provider id makes repeated syncs
 * idempotent. The ledger entry id points at the original auto-post; later
 * category changes are append-only reclassification entries so the accounting
 * audit trail remains intact.
 *
 * `needsReview` keeps a purchase in Banking's To review after it is in the
 * books: it arrives filed under its card's default category, and waits until
 * someone picks a category or keeps that one. Send to review sets it again.
 * Nothing in the books depends on it. A card bill payment has no category,
 * so it never waits, and purchases from before it existed start out reviewed.
 */
@Entity("card_transactions")
@Index(["feedId"])
@Index(["companyId", "feedId", "postedAt"])
@Index(["feedId", "externalId"], { unique: true })
export class CardTransaction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  feedId!: string;

  @Column({ type: "varchar" })
  externalId!: string;

  @Column({ type: "varchar", nullable: true })
  cardId!: string | null;

  @Column({ type: dateTimeColumnType })
  postedAt!: Date;

  /** Brex convention: purchases are positive; refunds and collections are
   * negative. */
  @Column({ type: "int" })
  amountCents!: number;

  @Column({ type: "varchar", default: "USD" })
  currency!: string;

  @Column({ type: "varchar", default: "" })
  description!: string;

  @Column({ type: "varchar", default: "" })
  providerType!: string;

  @Column({ type: "varchar" })
  accountingKind!: CardAccountingKind;

  @Column({ type: "varchar", nullable: true })
  expenseAccountId!: string | null;

  @Column({ type: "varchar", nullable: true })
  ledgerEntryId!: string | null;

  @Column({ type: "text", default: "" })
  postingError!: string;

  @Column({ type: "text", default: "" })
  raw!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  reclassifiedAt!: Date | null;

  @Column({ type: "boolean", default: false })
  needsReview!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
