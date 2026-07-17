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

  @Column({ type: "datetime" })
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

  @Column({ type: "datetime", nullable: true })
  reclassifiedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
