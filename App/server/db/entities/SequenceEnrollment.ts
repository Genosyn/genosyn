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
 * Why an enrolment is no longer sending. Every terminal state is distinct
 * because the difference matters operationally: `stopped_replied` is the
 * success case, `stopped_bounced` means fix your data, `stopped_unsubscribed`
 * is a compliance record, and `failed` needs somebody to look at it.
 */
export type EnrollmentStatus =
  | "active"
  | "paused"
  | "completed"
  | "stopped_replied"
  | "stopped_bounced"
  | "stopped_unsubscribed"
  | "stopped_manual"
  | "failed";

export const ENROLLMENT_STATUSES: EnrollmentStatus[] = [
  "active",
  "paused",
  "completed",
  "stopped_replied",
  "stopped_bounced",
  "stopped_unsubscribed",
  "stopped_manual",
  "failed",
];

/** Statuses that will never send again — the terminal set. */
export const TERMINAL_ENROLLMENT_STATUSES: EnrollmentStatus[] = [
  "completed",
  "stopped_replied",
  "stopped_bounced",
  "stopped_unsubscribed",
  "stopped_manual",
  "failed",
];

/**
 * One Contact moving through one {@link Sequence}. See ROADMAP.md M32.
 *
 * The unique `(sequenceId, contactId)` index is load-bearing: double-enrolling
 * somebody means they receive the same opening line twice, which is the single
 * most visible way an outbound tool embarrasses its owner. Re-enrolment is an
 * explicit action that resets the existing row rather than inserting a second.
 *
 * `nextRunAt` is the scheduler's only input — `tickSequences()` selects active
 * enrolments whose `nextRunAt` has passed, oldest first, so a backlog drains
 * fairly instead of one contact starving the rest (the fairness rule M29
 * established for routine dispatch).
 */
@Entity("sequence_enrollments")
@Index(["sequenceId", "contactId"], { unique: true })
@Index(["companyId", "status"])
@Index(["status", "nextRunAt"])
@Index(["companyId", "contactId"])
@Index(["mailThreadId"])
export class SequenceEnrollment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  sequenceId!: string;

  @Column({ type: "varchar" })
  contactId!: string;

  /** The Deal this outreach is working, when there is one. */
  @Column({ type: "varchar", nullable: true })
  dealId!: string | null;

  @Column({ type: "varchar", default: "active" })
  status!: EnrollmentStatus;

  /** Index of the next step to send. Equals the step count when completed. */
  @Column({ type: "int", default: 0 })
  currentStepOrder!: number;

  /** Null while paused or terminal. The scheduler reads only this. */
  @Column({ type: dateTimeColumnType, nullable: true })
  nextRunAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastStepAt!: Date | null;

  /** Human-readable detail behind a terminal status. */
  @Column({ type: "varchar", default: "" })
  stoppedReason!: string;

  /**
   * The thread the conversation lives in, set after the first touch. Reply
   * detection during mail sync matches inbound messages against this.
   */
  @Column({ type: "varchar", nullable: true })
  mailThreadId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
