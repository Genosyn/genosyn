import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * A bounded reporting period. Phase F of the Finance milestone (M19) —
 * see ROADMAP.md.
 *
 * Closing a period:
 *   1. Posts a single closing `LedgerEntry` that zeroes every revenue
 *      and expense account into 3100 Retained Earnings.
 *   2. Sets `status = "closed"`.
 *   3. Locks the period — `postLedgerEntry()` rejects any future
 *      writes whose date falls inside a closed period, and the
 *      finance routes propagate the same rejection on payment /
 *      voiding entries that would land in a closed window.
 */
export type AccountingPeriodStatus = "open" | "closed";

@Entity("accounting_periods")
@Index(["companyId", "startDate"])
@Index(["companyId", "status"])
export class AccountingPeriod {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "datetime" })
  startDate!: Date;

  @Column({ type: "datetime" })
  endDate!: Date;

  @Column({ type: "varchar", default: "open" })
  status!: AccountingPeriodStatus;

  @Column({ type: "datetime", nullable: true })
  closedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  closedById!: string | null;

  /** ID of the closing `LedgerEntry` we posted on close. Lets the UI
   *  surface "this is the entry that rolled P&L into retained earnings"
   *  and supports a clean re-open path (delete entry → flip status). */
  @Column({ type: "varchar", nullable: true })
  closingEntryId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
