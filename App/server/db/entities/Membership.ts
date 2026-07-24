import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

export type Role = "owner" | "admin" | "member";

/**
 * A member's access to the company's finance surface, orthogonal to their org
 * role (M33 A4):
 *   - `none` — the finance section is closed to them entirely.
 *   - `read` — they can view finances but not post, edit, or send anything.
 *   - `full` — unrestricted (the historical behaviour, and the default).
 *
 * Owners and admins are always treated as `full` regardless of this column; it
 * only ever restricts regular members. Existing rows default to `full`, so the
 * introduction of the role changes nothing until an owner dials someone down.
 */
export type FinanceAccess = "none" | "read" | "full";

@Entity("memberships")
@Index(["companyId", "userId"], { unique: true })
export class Membership {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  userId!: string;

  @Column({ type: "varchar" })
  role!: Role;

  @Column({ type: "varchar", default: "full" })
  financeAccess!: FinanceAccess;
}
