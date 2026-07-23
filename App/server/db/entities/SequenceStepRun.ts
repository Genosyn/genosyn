import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * - `drafted` — the employee wrote it; a human still has to press Send.
 * - `sent`    — it went out.
 * - `skipped` — deliberately not sent (suppressed, no address, cap reached).
 *               Not a failure; the reason says which.
 * - `failed`  — something broke. Needs a human.
 */
export type StepRunStatus = "drafted" | "sent" | "skipped" | "failed";

export const STEP_RUN_STATUSES: StepRunStatus[] = [
  "drafted",
  "sent",
  "skipped",
  "failed",
];

/**
 * One attempt at one step for one enrolment. See ROADMAP.md M32.
 *
 * Append-only. Exists so that "what exactly did we send this person, when, and
 * why did step 3 not go out" is answerable from the database rather than
 * inferred from mail headers — which matters the first time a prospect
 * complains they were mailed after unsubscribing, and matters again every time
 * somebody debugs a sequence that looks stalled.
 *
 * `skipped` carrying a reason is deliberate: a silent non-send is
 * indistinguishable from a bug, and the most common skip (suppressed address)
 * is the system working correctly.
 */
@Entity("sequence_step_runs")
@Index(["enrollmentId", "ranAt"])
@Index(["companyId", "ranAt"])
@Index(["enrollmentId", "stepId"])
export class SequenceStepRun {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  sequenceId!: string;

  @Column({ type: "varchar" })
  enrollmentId!: string;

  @Column({ type: "varchar" })
  stepId!: string;

  /** Copied from the step, so the history survives a step being reordered. */
  @Column({ type: "int", default: 0 })
  stepOrder!: number;

  @Column({ type: "varchar", default: "drafted" })
  status!: StepRunStatus;

  /** The draft or sent message, when one was created. */
  @Column({ type: "varchar", nullable: true })
  mailMessageId!: string | null;

  @Column({ type: "varchar", nullable: true })
  mailThreadId!: string | null;

  /** Why it was skipped, or what failed. Empty on a clean send. */
  @Column({ type: "text", default: "" })
  detail!: string;

  /** Snapshot of the subject line, for the timeline without a mail join. */
  @Column({ type: "varchar", default: "" })
  subject!: string;

  @Column({ type: dateTimeColumnType })
  ranAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
