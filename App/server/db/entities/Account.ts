import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Chart-of-accounts account type. Determines normal balance:
 *   - asset    : debit-normal  (cash, receivables, inventory)
 *   - liability: credit-normal (taxes payable, payables, loans)
 *   - equity   : credit-normal (owner's equity, retained earnings)
 *   - revenue  : credit-normal (sales, interest income)
 *   - expense  : debit-normal  (rent, salaries, COGS)
 *
 * Used by the trial balance + reports (Phase C) to lay accounts in the
 * correct columns and pick the right sign for "normal" balance.
 */
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

/**
 * One account in the company's chart of accounts. Phase B of the Finance
 * milestone (M19) — see ROADMAP.md.
 *
 * `code` is the 4-digit account number accountants think in (e.g. 1100
 * Bank, 1200 AR, 4000 Sales). Stored as a string because the world isn't
 * limited to 4 digits — sub-accounts use 4-2 ("1100-01") and some
 * jurisdictions use 5+. Unique per company.
 *
 * `isSystem` accounts are the ones the seeded chart of accounts plants
 * on first ledger visit (see `services/ledger.ts > seedChartOfAccounts`).
 * They cannot be deleted because the auto-post code paths look them up
 * by code (`1100`, `1200`, `2100`, `4000`) — deleting one would crash
 * `issueInvoice`. Renaming is fine.
 *
 * `parentId` points up the tree for hierarchical CoAs (e.g. 4000 Sales
 * Revenue → 4100 Product sales / 4200 Service revenue). Phase B doesn't
 * surface the tree in UI but reserves the column so Phase C reports can
 * roll up child balances into parents without a migration.
 */
@Entity("accounts")
@Index(["companyId", "code"], { unique: true })
@Index(["companyId", "type"])
export class Account {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  code!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  type!: AccountType;

  @Column({ type: "varchar", nullable: true })
  parentId!: string | null;

  @Column({ type: "boolean", default: false })
  isSystem!: boolean;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
