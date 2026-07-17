import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type CardFeedKind = "brex_card";

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

  @Column({ type: "datetime", nullable: true })
  lastSyncAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
