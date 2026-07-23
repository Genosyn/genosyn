import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Three escalating capabilities — owners/admins toggle these from
 * **Finance → AI access** to decide what an AI employee can do with the
 * company's finance system (invoices, customers, the books) through its
 * MCP tools:
 *   - `read`    → view invoices, customers, statements, reports, and the
 *                 chart of accounts / posted transactions. No writes.
 *   - `invoice` → read + run accounts receivable: draft, issue, email, and
 *                 void invoices; create and update customers; record and
 *                 reverse payments (mark an invoice paid). This is the tier
 *                 for an AI that keeps invoicing moving on its own.
 *   - `full`    → invoice + accounting review: stage general-ledger
 *                 re-categorizations for a human to approve
 *                 (`review_finance_transaction`). Still no final approval —
 *                 that stays with a human owner/admin.
 *
 * The order matters: `FINANCE_ACCESS_RANK` encodes it so a single comparison
 * covers "needs at least invoice" without a cascade of equality checks —
 * exactly like `MAIL_ACCESS_RANK` / `RESOURCE_ACCESS_RANK`.
 *
 * `read` is the default: sharing is opt-in, and the safe first step is to let
 * an employee see the books before it can move money around on them. Promote
 * to `invoice` for AR clerks and `full` for a bookkeeper.
 *
 * Unlike the mail/resource grants (one row per (employee, account/resource)),
 * finance is a single company-wide subsystem, so this is **one row per
 * employee**. Humans (members) bypass this table entirely; it only governs
 * the AI surface. The human Finance routes stay gated by company membership.
 */
export type FinanceAccessLevel = "read" | "invoice" | "full";

export const FINANCE_ACCESS_LEVELS: FinanceAccessLevel[] = [
  "read",
  "invoice",
  "full",
];

export const FINANCE_ACCESS_RANK: Record<FinanceAccessLevel, number> = {
  read: 0,
  invoice: 1,
  full: 2,
};

/**
 * Grants an AI employee access to the company's finance system. The level
 * decides which finance MCP tools succeed.
 */
@Entity("employee_finance_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeFinanceGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: FinanceAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
