import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Automation on inbound mail: "when an email arrives and matches these
 * conditions, do these actions."
 *
 * Evaluated by the sync service against every *new inbound* message it
 * ingests (drafts and self-sent mail never trigger rules). Rules run in
 * `position` order; every enabled rule that matches fires — there is no
 * stop-on-first-match, because labelling and handing to an employee are
 * usually complementary.
 *
 * `conditionsJson` (all present fields must match; substring, case-insensitive):
 *   { from?, to?, subjectContains?, bodyContains?, hasAttachment? }
 *
 * `actionsJson` — ordered array of:
 *   { type: "applyLabel", labelName }        // user label, created if missing
 *   { type: "markRead" } | { type: "star" } | { type: "archive" }
 *   { type: "handToEmployee", employeeId, instruction, mode }
 *     // mode: "draft" | "reply" | "triage" — creates a MailHandover
 */
@Entity("mail_rules")
@Index(["companyId"])
@Index(["accountId"])
export class MailRule {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /** Evaluation order, ascending. */
  @Column({ type: "int", default: 0 })
  position!: number;

  @Column({ type: "text", default: "{}" })
  conditionsJson!: string;

  @Column({ type: "text", default: "[]" })
  actionsJson!: string;

  @Column({ type: "int", default: 0 })
  matchCount!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastMatchedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
