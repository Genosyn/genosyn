import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import type { InputRequestKind, InputRequestStatus } from "../../../shared/inputRequests.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * Something an AI Employee needs from a person that only a person has: a one-time
 * code, a step on their own device, a fact no tool can reach.
 *
 * **Not a {@link Decision}.** A Decision is a choice the company has to make, with
 * options the employee wrote, and answering it records information. An Input
 * request is something the work physically can't get any other way. **Not an
 * {@link Approval}.** Nothing here interposes on an action or authorizes one.
 * Answering grants nothing: the work carries on with exactly what it could do
 * before.
 *
 * It holds the work. A Routine Run pauses as itself (`Run.waitingOnInputRequestId`)
 * and a Todo waits (`Todo.waitingOn`), so a person who answers in twelve hours
 * costs no model turn meanwhile and the same work carries on. See
 * `services/inputRequests.ts` for the lifecycle.
 */
@Entity("input_requests")
@Index(["companyId", "status"])
@Index(["employeeId", "status"])
// Every sweep reads the open rows through this, however many have closed.
@Index(["status", "nextReminderAt"])
// One piece of work holds one open request, and comes back to it.
@Index(["workKey", "status"])
export class InputRequest {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The AI Employee that asked. */
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  kind!: InputRequestKind;

  @Column({ type: "varchar", default: "waiting" })
  status!: InputRequestStatus;

  /**
   * The piece of work this belongs to: `run:<id>`, `todo:<id>`, `chat:<id>`, or
   * `session:<browser session id>` for a turn nothing can resume. A session that
   * comes back asks on the same row, so a person isn't asked twice.
   */
  @Column({ type: "varchar" })
  workKey!: string;

  @Column({ type: "varchar", nullable: true })
  runId!: string | null;

  @Column({ type: "varchar", nullable: true })
  routineId!: string | null;

  @Column({ type: "varchar", nullable: true })
  todoId!: string | null;

  @Column({ type: "varchar", nullable: true })
  conversationId!: string | null;

  /** The browser session holding the page, most recently. */
  @Column({ type: "varchar", nullable: true })
  browserSessionId!: string | null;

  /** The Vault login being signed in to, when the employee named one. Grants nothing. */
  @Column({ type: "varchar", nullable: true })
  vaultItemId!: string | null;

  /** Who is asked. Null: the company's owners and admins. */
  @Column({ type: "varchar", nullable: true })
  assigneeUserId!: string | null;

  /** Submitting needs Approval on this browser, so answering takes an owner or admin. */
  @Column({ type: "boolean", default: false })
  adminOnly!: boolean;

  /** The session read something from outside the company before it asked. */
  @Column({ type: "boolean", default: false })
  tainted!: boolean;

  /** Read from the browser by the server. Never from the AI Employee. */
  @Column({ type: "varchar", default: "" })
  pageOrigin!: string;

  /** When the page stops waiting, while `asking`. */
  @Column({ type: dateTimeColumnType, nullable: true })
  askingUntil!: Date | null;

  /** When a person last said they're ready. */
  @Column({ type: dateTimeColumnType, nullable: true })
  readyAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  readyByUserId!: string | null;

  /** When a person last gave what was asked for. */
  @Column({ type: dateTimeColumnType, nullable: true })
  answeredAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  answeredByUserId!: string | null;

  /** How many times a page has asked. */
  @Column({ type: "integer", default: 0 })
  attempts!: number;

  /** How many codes people have given. Bounded, since wrong codes lock accounts. */
  @Column({ type: "integer", default: 0 })
  codesGiven!: number;

  /** The page asked again after the last code, so that one didn't work. */
  @Column({ type: "boolean", default: false })
  lastCodeRefused!: boolean;

  /** How many reminders have gone since it last waited. */
  @Column({ type: "integer", default: 0 })
  reminders!: number;

  /** When the next reminder goes, while `waiting`. */
  @Column({ type: dateTimeColumnType, nullable: true })
  nextReminderAt!: Date | null;

  /** When it gives up. */
  @Column({ type: dateTimeColumnType })
  expiresAt!: Date;

  /** When it stopped being open. */
  @Column({ type: dateTimeColumnType, nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  /** The employee's words, redacted and bounded. Long text stays after the indexed columns. */
  @Column({ type: "varchar", default: "" })
  title!: string;

  /** The employee's words, redacted and bounded. */
  @Column({ type: "text", default: "" })
  body!: string;

  /**
   * A person's words, for an `answer`, or why they declined. The AI Employee reads
   * this, so it holds nothing secret: a code is never kept here.
   */
  @Column({ type: "text", nullable: true })
  answerText!: string | null;

  /**
   * A code on its way to the page: encrypted, scoped to this row, cleared by the
   * session the moment it takes it and by the sweep if it never does. It's here only
   * because the person's request and the page can be on different processes.
   */
  @Column({ type: "text", nullable: true })
  encryptedAnswer!: string | null;

  /** Why it ended, in a sentence a person can read. */
  @Column({ type: "text", default: "" })
  closeReason!: string;
}
