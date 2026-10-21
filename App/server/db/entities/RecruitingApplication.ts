import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import type { RecruitingStage, ScoreLabel } from "../../../shared/recruiting.js";
import { dateTimeColumnType } from "./columnTypes.js";

/** How an Application reached the company. */
export type ApplicationSource = "careers_site" | "internal" | "manual" | "sourced";

/**
 * Where the AI screen stands. `none` has not been asked for (no screener is
 * appointed, or automatic screening is off); `failed` means the screener could
 * not give a score — never a low one. A failed or missing screen is the
 * absence of a judgement, exactly as `unverified` is on a Run (AGENTS.md §3),
 * and no screen may read it as a reason to reject anyone.
 */
export type ApplicationScreenStatus = "none" | "queued" | "running" | "scored" | "failed";

/** Whether text could be read out of the uploaded resume for scoring. */
export type ResumeTextStatus = "none" | "extracted" | "unreadable";

/**
 * One person applying to one Opening.
 *
 * Everything the candidate typed or uploaded is untrusted: they are a
 * stranger, and a resume can address an AI as easily as an email can. It is
 * shown to Members as text, handed to the AI screener only as data inside a
 * restricted single-tool turn, and reading it through an AI Employee's tools
 * marks that turn tainted (`services/taintPolicy.ts`), so the instructions a
 * resume carries can never send mail or write a Routine.
 *
 * `score` and `scoreLabel` mirror the latest *AI screen*, for sorting and the
 * board; every Scorecard, including people's, stays on its own row.
 *
 * Long text is declared last so SQLite reads past none of it to filter on the
 * indexed columns above (AGENTS.md §7).
 */
@Entity("recruiting_applications")
@Index(["companyId", "createdAt"])
@Index(["openingId", "stage", "createdAt"])
@Index(["openingId", "clientSubmissionId"], { unique: true })
@Index(["companyId", "candidateEmail"])
@Index(["screenStatus", "screenQueuedAt"])
export class RecruitingApplication {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  openingId!: string;

  @Column({ type: "varchar" })
  candidateName!: string;

  /** Trimmed and lower-cased, so the same person is recognised across Openings. */
  @Column({ type: "varchar" })
  candidateEmail!: string;

  @Column({ type: "varchar", default: "" })
  candidatePhone!: string;

  @Column({ type: "varchar", default: "" })
  candidateLocation!: string;

  @Column({ type: "varchar", default: "" })
  linkedinUrl!: string;

  @Column({ type: "varchar", default: "" })
  websiteUrl!: string;

  @Column({ type: "varchar", default: "careers_site" })
  source!: ApplicationSource;

  /** Free text about the source: a referrer, or where an AI Employee found the person. */
  @Column({ type: "varchar", default: "" })
  sourceDetail!: string;

  /** The Member who applied through an internal Opening, when one did. */
  @Column({ type: "varchar", nullable: true })
  applicantUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @Column({ type: "varchar", default: "applied" })
  stage!: RecruitingStage;

  @Column({ type: dateTimeColumnType })
  stageChangedAt!: Date;

  @Column({ type: "varchar", default: "" })
  rejectionReason!: string;

  @Column({ type: "varchar", default: "none" })
  screenStatus!: ApplicationScreenStatus;

  @Column({ type: "integer", default: 0 })
  screenAttempts!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  screenQueuedAt!: Date | null;

  /** When the running screen started; a stale one is reclaimed after a restart. */
  @Column({ type: dateTimeColumnType, nullable: true })
  screenStartedAt!: Date | null;

  /** The latest AI screen's score, 0–100. */
  @Column({ type: "integer", nullable: true })
  score!: number | null;

  @Column({ type: "varchar", nullable: true })
  scoreLabel!: ScoreLabel | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  scoredAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  latestScorecardId!: string | null;

  /** The screener found instructions aimed at an AI inside the application. */
  @Column({ type: "boolean", default: false })
  injectionFlag!: boolean;

  /**
   * `sending` while the confirmation is claimed and on its way, then `sent`,
   * `failed` or `skipped`; empty when no confirmation was due.
   */
  @Column({ type: "varchar", default: "" })
  confirmationEmailStatus!: string;

  /** When the candidate agreed to the company processing their application. */
  @Column({ type: dateTimeColumnType, nullable: true })
  consentAt!: Date | null;

  /** A browser-generated id, so retrying an uncertain submit never applies twice. */
  @Column({ type: "varchar", nullable: true })
  clientSubmissionId!: string | null;

  /** Basename under the company's recruiting directory. */
  @Column({ type: "varchar", nullable: true })
  resumeFileKey!: string | null;

  @Column({ type: "varchar", default: "" })
  resumeFileName!: string;

  @Column({ type: "varchar", default: "" })
  resumeMimeType!: string;

  @Column({ type: "integer", default: 0 })
  resumeSize!: number;

  @Column({ type: "varchar", default: "none" })
  resumeTextStatus!: ResumeTextStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** Why the last screen failed, in a sentence a person can act on. */
  @Column({ type: "text", default: "" })
  screenError!: string;

  /** `ApplicationAnswer[]`, each with the question as it was asked. */
  @Column({ type: "text", default: "[]" })
  answersJson!: string;

  @Column({ type: "text", default: "" })
  coverLetter!: string;

  /** Text read out of the resume, capped; what the screener and AI Employees read. */
  @Column({ type: "text", default: "" })
  resumeText!: string;
}
