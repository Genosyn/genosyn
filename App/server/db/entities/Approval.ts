import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * Human-in-the-loop gate for routines marked `requiresApproval`. When the
 * cron tick fires for such a routine we insert a pending Approval instead
 * of running. A human approves (→ we run the routine; approval is stamped
 * `approved` + decidedAt) or rejects (→ nothing runs; approval is stamped
 * `rejected`).
 *
 * Manual "Run now" from the UI bypasses this — a human is already in the
 * loop at that point.
 */
@Entity("approvals")
export class Approval {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Index()
  @Column({ type: "varchar" })
  routineId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: ApprovalStatus;

  @CreateDateColumn()
  requestedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  decidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;
}
