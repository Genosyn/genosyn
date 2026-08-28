import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

export type ApprovalStatus =
  | "pending"
  | "executing"
  | "approved"
  | "execution_failed"
  | "rejected"
  | "expired";

/**
 * Approval kinds. Each kind has its own execute path in
 * `services/approvals.ts` plus its own UI rendering.
 *
 *   - `routine`           — cron tick for a routine marked `requiresApproval`
 *   - `lightning_payment` — a Lightning payment whose amount exceeded the
 *                            Connection's `requireApprovalAboveSats` knob
 *   - `browser_action`    — a `browser_submit` call from an AI employee
 *                            whose `browserApprovalRequired` flag is on.
 *                            The MCP child holds the pending action; the
 *                            model retries via `browser_resume(approvalId)`
 *                            once status flips to `approved`. Resume first
 *                            atomically claims the row as `executing`; a crash
 *                            leaves that ambiguous claim non-replayable. The
 *                            server does not re-fire — only the MCP child can
 *                            drive the live browser session.
 *   - `mcp_tool`          — a guarded tool on a company-configured MCP
 *                            server (`McpServer.guardedToolsJson` glob
 *                            match). The verbatim call is snapshotted on
 *                            `payloadJson` and replayed server-side on
 *                            approve by reconnecting to the same server.
 *   - `ad_spend`          — a spend-increasing ad-platform mutation
 *                            (budget raise, campaign enable) above the
 *                            Connection's approval threshold. Replayed on
 *                            approve with hard caps still enforced and a
 *                            drift check against the queued snapshot.
 *   - `autonomy_promotion` — the eligibility sweep proposing one earned
 *                            autonomy waiver (M53), evidence in the summary.
 *                            Approve applies the specific gate change and
 *                            writes the `AutonomyWaiver` row; any failed or
 *                            off-goal Run revokes it automatically.
 *   - `tainted_tool`      — a high-risk sink (`send_mail`, Routine writes)
 *                            called by a turn that had ingested web content
 *                            (M53's taint policy). The verbatim call is
 *                            snapshotted on `payloadJson` and replayed on
 *                            approve through the loopback internal API with
 *                            a fresh employee-authority token.
 */
export type ApprovalKind =
  | "routine"
  | "lightning_payment"
  | "browser_action"
  | "mcp_tool"
  | "ad_spend"
  | "autonomy_promotion"
  | "tainted_tool";

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

  /** Failure message captured when post-approval execution throws. The
   *  status becomes `execution_failed`: the human decision and failure are
   *  both durable, and another Approve request cannot replay the action. */
  @Column({ type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "varchar", default: "pending" })
  status!: ApprovalStatus;

  @CreateDateColumn()
  requestedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  decidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;

  /**
   * When the stall sweep re-paged humans about this row still being pending
   * (`services/escalations.ts`). Null means it has never been re-paged, which
   * is also what makes the sweep's query cheap: it selects only unreminded
   * rows rather than paging past ones it has already handled. Durable on the
   * row on purpose — the bell notification it produces is something a Member
   * can delete, and a deletable marker would re-arm the nag forever.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  stallRemindedAt!: Date | null;
}
