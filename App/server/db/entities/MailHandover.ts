import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/** What the employee is being asked to do with the thread. */
export type MailHandoverMode = "draft" | "reply" | "triage";

export type MailHandoverStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type MailHandoverSource = "manual" | "rule";

/**
 * One email thread handed to one AI employee — "answer this", "draft a
 * reply", "file it". Created by a human from the thread view or by a
 * MailRule's handToEmployee action; executed by the in-process handover
 * queue through the chat seam, so the employee works with its full Soul /
 * Memory / Skills and its mail tools.
 *
 * Modes: `draft` asks for a Gmail draft in the thread (human reviews and
 * sends), `reply` lets the employee send directly (requires the `send`
 * grant), `triage` asks for labelling / archiving only. The mode shapes the
 * instruction we compose; the grant level is what actually enforces it.
 *
 * Not a `Handoff` — that entity is AI→AI delegation. See ROADMAP vocabulary.
 */
@Entity("mail_handovers")
@Index(["companyId"])
@Index(["threadId"])
@Index(["accountId", "status"])
export class MailHandover {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  /** Local MailThread id. */
  @Column({ type: "varchar" })
  threadId!: string;

  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "draft" })
  mode!: MailHandoverMode;

  /** What the human (or rule) asked for, in their words. */
  @Column({ type: "text", default: "" })
  instruction!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: MailHandoverStatus;

  /** The employee's closing summary of what it did. */
  @Column({ type: "text", default: "" })
  resultSummary!: string;

  @Column({ type: "text", default: "" })
  errorMessage!: string;

  @Column({ type: "varchar", default: "manual" })
  sourceKind!: MailHandoverSource;

  /** The MailRule that created this, when sourceKind is `rule`. */
  @Column({ type: "varchar", nullable: true })
  ruleId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "datetime", nullable: true })
  startedAt!: Date | null;

  @Column({ type: "datetime", nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
