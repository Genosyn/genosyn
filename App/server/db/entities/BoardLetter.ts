import { dateTimeColumnType } from "./columnTypes.js";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Where a letter is in its life:
 *
 * - `writing`  — claimed; its figures are computed and the writer is drafting.
 * - `auditing` — written and traced; the board's auditor is reading it.
 * - `ready`    — finished, whatever the audit concluded, and sent to the board.
 * - `failed`   — the writer could not produce it. A scheduled letter is tried
 *                again (`retryAt`); a person can try again at any time.
 */
export type BoardLetterStatus = "writing" | "auditing" | "ready" | "failed";

/**
 * The auditor's opinion, kept apart from the trace and never inferred:
 *
 * - `pending`       — no opinion yet; the letter is still being written or read.
 * - `clean`         — the auditor read the letter against its figures and
 *                     evidence and found nothing to report.
 * - `exceptions`    — the auditor reported findings; they travel with the letter.
 * - `unverified`    — an auditor was appointed but **no opinion was produced**:
 *                     no connected AI Model, a Standdown, an error, a timeout.
 *                     Never read as clean, exactly like a Run's `unverified`.
 * - `not_appointed` — the board had appointed no auditor when it was written.
 */
export type BoardLetterAuditStatus =
  | "pending"
  | "clean"
  | "exceptions"
  | "unverified"
  | "not_appointed";

export type BoardLetterTrigger = "schedule" | "manual";

/**
 * One monthly letter to the board.
 *
 * Three hands, kept apart on purpose. The **server** computes every figure
 * (`figuresJson`) from the ledger, the Goals, the Runs and the Decision stack
 * and writes down where each one comes from. The **writer**, an AI Employee
 * the board chose, writes only the prose (`summary`, `body`) in a restricted
 * turn that can submit the letter and do nothing else. The **trace**
 * (`traceJson`) and the board's **auditor** then check the prose against the
 * figures. Nothing the writer submits can change a figure, the trace or the
 * audit, and no MCP tool writes any of them.
 *
 * A letter is a record: there is no route that edits or deletes one. Writer
 * and auditor are snapshotted so a letter still reads correctly after either
 * employee is deleted.
 *
 * Filterable columns come before the large text columns (AGENTS.md §7).
 */
@Entity("board_letters")
@Index(["companyId", "month"], { unique: true })
@Index(["companyId", "number"], { unique: true })
@Index(["status", "startedAt"])
export class BoardLetter {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** No. 1, No. 2, … in the order letters were begun, one per month. */
  @Column({ type: "integer" })
  number!: number;

  /** `YYYY-MM`, the month on the company's clock this letter covers. */
  @Column({ type: "varchar" })
  month!: string;

  @Column({ type: dateTimeColumnType })
  periodStart!: Date;

  @Column({ type: dateTimeColumnType })
  periodEnd!: Date;

  /** The zone the month was read in; empty for server time. */
  @Column({ type: "varchar", default: "" })
  timeZone!: string;

  @Column({ type: "varchar", default: "writing" })
  status!: BoardLetterStatus;

  @Column({ type: "varchar", default: "schedule" })
  triggerKind!: BoardLetterTrigger;

  /** Writing attempts so far, counting the current one. */
  @Column({ type: "integer", default: 0 })
  attempts!: number;

  /** When a failed scheduled letter is due another attempt. Null: no retry owed. */
  @Column({ type: dateTimeColumnType, nullable: true })
  retryAt!: Date | null;

  /** When the current attempt began. */
  @Column({ type: dateTimeColumnType })
  startedAt!: Date;

  @Column({ type: dateTimeColumnType, nullable: true })
  writtenAt!: Date | null;

  /** When the board was told. Claimed once, so nobody is told twice. */
  @Column({ type: dateTimeColumnType, nullable: true })
  deliveredAt!: Date | null;

  /** Null after the writer is deleted; the snapshot below survives. */
  @Column({ type: "varchar", nullable: true })
  writerEmployeeId!: string | null;

  @Column({ type: "varchar", default: "" })
  writerName!: string;

  @Column({ type: "varchar", default: "" })
  writerRole!: string;

  @Column({ type: "varchar", default: "" })
  writerSlug!: string;

  @Column({ type: "varchar", nullable: true })
  writerAvatarKey!: string | null;

  @Column({ type: "varchar", default: "pending" })
  auditStatus!: BoardLetterAuditStatus;

  @Column({ type: "varchar", nullable: true })
  auditorEmployeeId!: string | null;

  @Column({ type: "varchar", default: "" })
  auditorName!: string;

  @Column({ type: "varchar", default: "" })
  auditorRole!: string;

  @Column({ type: "varchar", default: "" })
  auditorSlug!: string;

  @Column({ type: "varchar", nullable: true })
  auditorAvatarKey!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  auditedAt!: Date | null;

  /** Numbers in the letter that match none of its figures. */
  @Column({ type: "integer", default: 0 })
  untracedCount!: number;

  /** One sentence, for the list, the bell and the email subject line. */
  @Column({ type: "text", default: "" })
  summary!: string;

  @Column({ type: "text", default: "" })
  errorMessage!: string;

  /** The auditor's opinion in a sentence or two. */
  @Column({ type: "text", default: "" })
  auditNote!: string;

  /** JSON `{ quote, problem }[]`: what the auditor flagged, quoted from the letter. */
  @Column({ type: "text", default: "[]" })
  auditFindingsJson!: string;

  /** JSON `{ summary, body }` traces (`services/boardLetterTrace.ts`). */
  @Column({ type: "text", default: "{}" })
  traceJson!: string;

  /** JSON figures with their sources (`services/boardLetterFigures.ts`). */
  @Column({ type: "text", default: "{}" })
  figuresJson!: string;

  /** JSON: the bounded, redacted evidence the writer and the auditor read. */
  @Column({ type: "text", default: "{}" })
  evidenceJson!: string;

  /** The letter itself: plain paragraphs, separated by blank lines. */
  @Column({ type: "text", default: "" })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
