import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type MailInboundAnalysisStatus = "running" | "succeeded" | "failed";

/**
 * One AI Employee's read of one inbound email, and the action buttons it
 * proposed off the back of it.
 *
 * Every message that arrives in a mailbox with AI analysis switched on gets a
 * row here: a short category, a one-line summary a human can scan, and up to
 * a handful of one-click next steps. The buttons never fire by themselves —
 * they run through the ordinary human routes when a Member presses them, with
 * that Member's authority, exactly like the per-email chat's suggestions.
 *
 * `messageId` is unique, which makes the row both the result and the replay
 * guard: re-analysing a message updates its verdict in place instead of
 * stacking a second row of buttons under the same email.
 *
 * `employeeId` / `modelId` record who actually read the email, so a Member
 * looking at a strange verdict can see which brain produced it rather than
 * guessing from the mailbox's current setting — which may have changed since.
 */
@Entity("mail_inbound_analyses")
@Index(["companyId"])
@Index(["accountId", "status"])
@Index(["threadId"])
@Index(["messageId"], { unique: true })
export class MailInboundAnalysis {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  /** Local `MailThread.id` — what the thread view queries by. */
  @Column({ type: "varchar" })
  threadId!: string;

  @Column({ type: "varchar" })
  messageId!: string;

  @Column({ type: "varchar", default: "running" })
  status!: MailInboundAnalysisStatus;

  /** The AI Employee that read the email. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /** The AI Model the read ran on. */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  /**
   * A coarse bucket from a closed vocabulary — see `MAIL_ANALYSIS_CATEGORIES`.
   * Deliberately not free text: it drives a coloured chip, and a model that
   * invents a new label every time makes the inbox harder to scan, not easier.
   */
  @Column({ type: "varchar", default: "" })
  category!: string;

  /** One scannable line about what this email wants. Never a rewrite of it. */
  @Column({ type: "text", default: "" })
  summary!: string;

  /** Serialized `MailAnalysisAction[]`, each with its server-verified target. */
  @Column({ type: "text", default: "[]" })
  actionsJson!: string;

  @Column({ type: "text", default: "" })
  errorMessage!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
