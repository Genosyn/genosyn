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
export type AuditActorKind = "user" | "system" | "webhook" | "cron";

@Entity("audit_events")
@Index(["companyId", "createdAt"])
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
