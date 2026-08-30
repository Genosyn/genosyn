import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Append-only record of mutations within a company. Instrumented at the route
 * seam via {@link recordAudit}. Intentionally non-structured — the metadataJson
 * blob carries whatever context is useful for a given action (e.g. a renamed
 * routine carries `{from, to}`). The UI renders a friendly sentence from
 * `action` + `targetLabel` and exposes the raw JSON on expand.
 */
export type AuditActorKind = "user" | "system" | "webhook" | "cron" | "ai";

@Entity("audit_events")
@Index(["companyId", "createdAt"])
// The per-Run effect digest: everything one Run changed, in order.
@Index(["runId"])
// "What did this employee do, and when" — the filter the audit page grew and
// the query the reporting line needs to review a bad autonomous window.
@Index(["companyId", "actorEmployeeId", "createdAt"])
export class AuditEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar", default: "user" })
  actorKind!: AuditActorKind;

  /** Null for non-user actors (system, cron, anonymous webhook). */
  @Column({ type: "varchar", nullable: true })
  actorUserId!: string | null;

  /**
   * AI Employee that performed this action, when `actorKind === "ai"`. Set
   * by the built-in Genosyn MCP server when an employee calls a write tool
   * from within its chat or routine run.
   */
  @Column({ type: "varchar", nullable: true })
  actorEmployeeId!: string | null;

  /**
   * The Run this mutation happened inside, when a Routine's MCP token
   * authorized it. Provenance the token has carried since it was minted
   * (`services/mcpTokens.ts`) and that `recordAudit` used to drop one
   * statement before writing the row.
   *
   * This column is what turns the audit log into an **effect ledger**: the
   * ordered list of what a Run actually changed, written by the server at each
   * write seam rather than narrated by the model afterwards. Null for chat
   * turns, human actions, and external MCP sessions.
   */
  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  /** The conversation this mutation happened inside, from the same seam. */
  @Column({ type: "varchar", nullable: true })
  conversationId!: string | null;

  /** Dotted name — `employee.create`, `routine.update`, `approval.approve`. */
  @Column({ type: "varchar" })
  action!: string;

  /** Entity kind the action targeted — `employee`, `routine`, `secret`, etc. */
  @Column({ type: "varchar", default: "" })
  targetType!: string;

  @Column({ type: "varchar", nullable: true })
  targetId!: string | null;

  /** Human-friendly label for the target at the time of the event. */
  @Column({ type: "varchar", default: "" })
  targetLabel!: string;

  /** Small JSON blob of additional context; must stay compact. */
  @Column({ type: "text", default: "" })
  metadataJson!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
