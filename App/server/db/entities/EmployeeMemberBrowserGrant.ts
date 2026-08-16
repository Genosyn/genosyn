import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * Grants one AI employee the right to drive one {@link MemberBrowser}. Same
 * shape as every other `Employee*Grant` in this codebase: a join row, unique
 * on the pair so a duplicate grant is a no-op, and revocation is a row delete.
 *
 * The grant is necessary but not sufficient. `services/memberBrowsers.ts`
 * re-checks on every browser RPC that the row still exists, that the browser
 * is not revoked, and — for a Routine — that the owner opted into unattended
 * use. Deleting this row therefore stops an in-flight Run, not just the next one.
 */
@Entity("employee_member_browser_grants")
@Index(["employeeId"])
@Index(["memberBrowserId"])
@Index(["employeeId", "memberBrowserId"], { unique: true })
export class EmployeeMemberBrowserGrant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  memberBrowserId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
