import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Three escalating capabilities — owners/admins toggle these from
 * **Revenue → AI access** to decide what an AI employee may do with the
 * company's customers and prospects:
 *
 *   - `read`  → see contacts, deals, activities, signals and revenue reports.
 *   - `write` → create and update contacts and deals, log activities, move a
 *               deal between stages, enroll somebody in a sequence.
 *   - `send`  → let a sequence this employee drafts go out **without** a human
 *               pressing Send. Strictly more dangerous than `write`, because it
 *               is the only level that spends the company's sending reputation
 *               unattended — and it is still gated a second time by the mail
 *               account grant.
 *
 * The order matters: `REVENUE_ACCESS_RANK` encodes it so a single comparison
 * covers "needs at least write", exactly like `FINANCE_ACCESS_RANK` /
 * `MAIL_ACCESS_RANK` / `RESOURCE_ACCESS_RANK`.
 *
 * One row per employee — this gates a whole subsystem, not a single resource.
 * An employee with **no** row gets no revenue tool at all (`grantDead`), which
 * is the same default the finance surface settled on: access to the customer
 * list is opt-in, never inherited from merely existing.
 */
export type RevenueAccessLevel = "read" | "write" | "send";

export const REVENUE_ACCESS_LEVELS: RevenueAccessLevel[] = ["read", "write", "send"];

export const REVENUE_ACCESS_RANK: Record<RevenueAccessLevel, number> = {
  read: 0,
  write: 1,
  send: 2,
};

@Entity("employee_revenue_grants")
@Index(["companyId"])
@Index(["employeeId"], { unique: true })
export class EmployeeRevenueGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "read" })
  accessLevel!: RevenueAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
