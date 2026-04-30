import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * Approval kinds. Each kind has its own execute path in
 * `services/approvals.ts` plus its own UI rendering.
 *
 *   - `routine`           — cron tick for a routine marked `requiresApproval`
 *   - `lightning_payment` — a Lightning payment whose amount exceeded the
 *                            Connection's `requireApprovalAboveSats` knob
 */
export type ApprovalKind = "routine" | "lightning_payment";

/**
 * Human-in-the-loop gate. Two flavors today (see `ApprovalKind`):
 *
 *   * **Routine approvals** are created by the cron when a routine marked
 *     `requiresApproval` ticks. Approving runs the routine; rejecting
 *     records a system journal entry. This is the original use case.
 *   * **Payment approvals** are created when an AI employee tries to send
 *     a Lightning payment over its Connection's `requireApprovalAboveSats`
 *     threshold. The original tool call is captured on `payloadJson` and
 *     replayed on approve.
 *
 * `routineId` stays a non-nullable column for sqlite ALTER-COLUMN reasons
 * — non-routine approvals leave it as the empty string. Read it through
 * the kind dispatcher in `services/approvals.ts` rather than directly.
 */
@Entity("approvals")
export class Approval {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Index()
  @Column({ type: "varchar", default: "routine" })
  kind!: ApprovalKind;

  @Index()
  @Column({ type: "varchar" })
  routineId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  /** Short label for the approvals inbox row. Set for non-routine kinds;
   *  routine kinds derive their label from the joined Routine row. */
  @Column({ type: "varchar", nullable: true })
  title!: string | null;

  /** One-line plain-text description for the inbox. */
  @Column({ type: "text", nullable: true })
  summary!: string | null;

  /** Kind-specific payload, JSON-encoded. For lightning_payment:
   *  `{ connectionId, toolName, args, amountSats, description? }`. */
  @Column({ type: "text", nullable: true })
  payloadJson!: string | null;

  /** Outcome JSON written after a successful execute (e.g. preimage from
   *  a paid invoice). Null while pending and on rejection. */
  @Column({ type: "text", nullable: true })
  resultJson!: string | null;

  /** Failure message captured when execute throws after approval. The
   *  approval stays `approved` (a human said yes) but the result is
   *  captured here for the inbox to surface. */
  @Column({ type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "varchar", default: "pending" })
  status!: ApprovalStatus;

  @CreateDateColumn()
  requestedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  decidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;
}
