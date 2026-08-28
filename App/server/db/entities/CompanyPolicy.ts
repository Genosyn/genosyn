import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * A company-wide rule (M53) — the layer above the Soul. A Soul governs one
 * employee; a Policy governs all of them at once, and it is more than prompt
 * text: alongside the prose that rides into every employee's system prompt,
 * a Policy can carry two mechanical clause kinds that hold even when a
 * model's context has drifted:
 *
 *  - **Blocked recipient domains** — enforced at the same mail-send choke
 *    point Suppression uses, for every sender, human or AI. A policy binds
 *    the company, not just its models, for exactly the reason Suppression
 *    does: the reputational damage of getting it wrong lands on the whole
 *    sending domain.
 *  - **Forbidden tools** — genosyn catalogue tool names refused at MCP
 *    dispatch company-wide, with the attempt recorded as a
 *    `policy.violation` AuditEvent.
 *
 * `find_tools` and `call_tool` cannot be forbidden — bricking discovery
 * would not restrict the catalogue, only hide which calls were refused.
 */
@Entity("company_policies")
@Index(["companyId", "enabled"])
export class CompanyPolicy {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  title!: string;

  /** The prose every employee reads, under "## Company policies". */
  @Column({ type: "text", default: "" })
  body!: string;

  /** Newline-separated domains ("competitor.com") no send may address. */
  @Column({ type: "text", default: "" })
  blockedRecipientDomains!: string;

  /** Newline-separated genosyn tool names refused company-wide. */
  @Column({ type: "text", default: "" })
  forbiddenTools!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
