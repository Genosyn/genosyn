import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Three escalating capabilities — humans toggle these from the Email
 * section's AI-access panel to decide what an AI employee can do with a
 * connected mailbox through its MCP tools:
 *   - `read`  → list / search / read threads and labels only
 *   - `draft` → read + write drafts, apply labels, archive, star, mark read
 *   - `send`  → draft + send mail on the account's behalf
 *
 * The order matters: `MAIL_ACCESS_RANK` encodes it so a single comparison
 * covers "needs at least draft" without a cascade of equality checks.
 *
 * `draft` is the default — it is the human-in-the-loop sweet spot: the
 * employee can triage the inbox and put a fully-written reply in the
 * thread, but a human presses Send. Promote to `send` only for employees
 * trusted to speak for the company unattended.
 */
export type MailAccessLevel = "read" | "draft" | "send";

export const MAIL_ACCESS_LEVELS: MailAccessLevel[] = ["read", "draft", "send"];

export const MAIL_ACCESS_RANK: Record<MailAccessLevel, number> = {
  read: 0,
  draft: 1,
  send: 2,
};

/**
 * Grants an AI employee access to a MailAccount. The level decides which
 * mail MCP tools succeed. Humans (members) bypass this table entirely; it
 * only governs the AI surface.
 */
@Entity("employee_mail_account_grants")
@Index(["employeeId"])
@Index(["accountId"])
@Index(["employeeId", "accountId"], { unique: true })
export class EmployeeMailAccountGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar", default: "draft" })
  accessLevel!: MailAccessLevel;

  @CreateDateColumn()
  createdAt!: Date;
}
