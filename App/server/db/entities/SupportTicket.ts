import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type {
  SupportPriority,
  SupportSentiment,
  SupportTicketSource,
  SupportTicketStatus,
} from "../../../shared/support.js";
import { dateTimeColumnType } from "./columnTypes.js";

export type SupportFieldSource = "default" | "ai" | "member";
export type { SupportTicketSource };

/**
 * One customer's request.
 *
 * The queue reads this row and never a message body: everything a list shows or
 * filters on is stored ahead of the long text at the end of the row, and every
 * queue has an index that ends in its sort, so a page is read from the index.
 * The denormalized flags exist for that reason alone — `actionable`,
 * `draftReady` and `aiHandled` are each one question a queue asks.
 *
 * `(accountId, gmailThreadId)` is unique, which is what keeps two messages in
 * one conversation from opening two tickets however they race. `gmailThreadId`
 * holds the mailbox's handle for the conversation, like the mirror's column of
 * the same name, and stays null on a ticket that has not gone out by email yet;
 * null never collides. A ticket opened from the Chat widget starts that way, with
 * `requesterEmail` empty until the visitor confirms an address.
 */
@Entity("support_tickets")
@Index(["companyId", "number"], { unique: true })
@Index(["accountId", "gmailThreadId"], { unique: true })
@Index(["companyId", "lastActivityAt", "id"])
@Index(["companyId", "actionable", "lastActivityAt", "id"])
@Index(["companyId", "status", "lastActivityAt", "id"])
@Index(["companyId", "assigneeUserId", "lastActivityAt", "id"])
@Index(["companyId", "draftReady", "lastActivityAt", "id"])
@Index(["companyId", "aiHandled", "lastActivityAt", "id"])
@Index(["companyId", "priorityRank", "lastActivityAt", "id"])
@Index(["companyId", "slaDueAt", "id"])
@Index(["companyId", "source", "lastActivityAt", "id"])
@Index(["companyId", "requesterEmail", "createdAt"])
@Index(["companyId", "createdAt"])
@Index(["chatVisitorId", "createdAt"])
@Index(["inboxId", "lastActivityAt", "id"])
@Index(["slaDueAt"])
@Index(["status", "snoozedUntil"])
@Index(["status", "solvedAt"])
@Index(["ratingDueAt"])
export class SupportTicket {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The number a person says out loud: #1042. Handed out once per company. */
  @Column({ type: "int" })
  number!: number;

  @Column({ type: "varchar", nullable: true })
  inboxId!: string | null;

  @Column({ type: "varchar", nullable: true })
  accountId!: string | null;

  /** The mailbox's handle for this conversation. See the class doc. */
  @Column({ type: "varchar", nullable: true })
  gmailThreadId!: string | null;

  @Column({ type: "varchar", default: "new" })
  status!: SupportTicketStatus;

  /** Status is `new` or `open`: somebody at the company owes an answer. */
  @Column({ type: "boolean", default: true })
  actionable!: boolean;

  @Column({ type: "varchar", default: "normal" })
  priority!: SupportPriority;

  /** `SUPPORT_PRIORITY_RANK` of `priority`, so a list can page by it. */
  @Column({ type: "int", default: 2 })
  priorityRank!: number;

  /** Who set the priority. A person's choice is never overridden by the AI. */
  @Column({ type: "varchar", default: "default" })
  prioritySource!: SupportFieldSource;

  @Column({ type: "varchar", nullable: true })
  topicKey!: string | null;

  @Column({ type: "varchar", default: "default" })
  topicSource!: SupportFieldSource;

  @Column({ type: "varchar", default: "" })
  subject!: string;

  /** Where replies go: the customer's Reply-To when they gave one, else From. */
  @Column({ type: "varchar", default: "" })
  requesterEmail!: string;

  @Column({ type: "varchar", default: "" })
  requesterName!: string;

  /** The watched address the customer wrote to. Replies come from it where they can. */
  @Column({ type: "varchar", default: "" })
  matchedAddress!: string;

  /** The Customer this requester belongs to, matched by address or domain. */
  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  /** The Revenue Contact with this address, if one exists. Never created from here. */
  @Column({ type: "varchar", nullable: true })
  contactId!: string | null;

  @Column({ type: "varchar", nullable: true })
  assigneeUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  assigneeEmployeeId!: string | null;

  /** An AI draft is ready for a Member to review. */
  @Column({ type: "boolean", default: false })
  draftReady!: boolean;

  /** The AI's reply went out on its own, and no person has replied since. */
  @Column({ type: "boolean", default: false })
  aiHandled!: boolean;

  /** The AI Employee says this one needs a person; see `aiHandoffReason`. */
  @Column({ type: "boolean", default: false })
  needsHuman!: boolean;

  @Column({ type: "int", default: 0 })
  aiReplyCount!: number;

  @Column({ type: "varchar", nullable: true })
  sentiment!: SupportSentiment | null;

  /** BCP 47 tag of the language the customer wrote in, as the AI Employee read it. */
  @Column({ type: "varchar", default: "" })
  language!: string;

  /** Customer and team messages, notes excluded. */
  @Column({ type: "int", default: 0 })
  messageCount!: number;

  @Column({ type: "int", default: 0 })
  reopenCount!: number;

  /** The queue's sort: the last time anything worth a look happened here. */
  @Column({ type: dateTimeColumnType })
  lastActivityAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastCustomerMessageAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastAgentMessageAt!: Date | null;

  /** The target for the first reply. Kept once set, so it can be reported on. */
  @Column({ type: dateTimeColumnType, nullable: true })
  firstResponseDueAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  firstRespondedAt!: Date | null;

  /** When the customer's latest unanswered message should have its answer. */
  @Column({ type: dateTimeColumnType, nullable: true })
  responseDueAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  resolutionDueAt!: Date | null;

  /** The next target running out, while a ticket is actionable; else null. */
  @Column({ type: dateTimeColumnType, nullable: true })
  slaDueAt!: Date | null;

  /** The first time a running target was missed. Reported once. */
  @Column({ type: dateTimeColumnType, nullable: true })
  slaBreachedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  solvedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  closedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  snoozedUntil!: Date | null;

  /** The ticket this one was merged into. Mail on its conversation goes there too. */
  @Column({ type: "varchar", nullable: true })
  mergedIntoId!: string | null;

  /** 1 to 5, as the customer gave it. */
  @Column({ type: "int", nullable: true })
  ratingScore!: number | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  ratingAt!: Date | null;

  /** When to ask for a rating, while one is owed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  ratingDueAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  ratingRequestedAt!: Date | null;

  /** The customer's link is a bearer credential: only its hash is kept. */
  @Column({ type: "varchar", nullable: true })
  ratingTokenHash!: string | null;

  @Column({ type: "varchar", default: "email" })
  source!: SupportTicketSource;

  /** The Chat widget visitor this is the conversation of. Replies are written for them. */
  @Column({ type: "varchar", nullable: true })
  chatVisitorId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** JSON array of addresses kept on replies: the customer's colleagues. */
  @Column({ type: "text", default: "[]" })
  ccJson!: string;

  /** JSON array of short labels. */
  @Column({ type: "text", default: "[]" })
  tagsJson!: string;

  /** The AI Employee's running summary, for the company's own people. */
  @Column({ type: "text", default: "" })
  aiSummary!: string;

  /** What the AI Employee thinks should happen next. */
  @Column({ type: "text", default: "" })
  aiNextStep!: string;

  @Column({ type: "text", default: "" })
  aiHandoffReason!: string;

  @Column({ type: "text", default: "" })
  spamReason!: string;

  @Column({ type: "text", default: "" })
  ratingComment!: string;
}
