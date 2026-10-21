import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { ScoreLabel } from "../../../shared/recruiting.js";

/**
 * Who wrote a Scorecard:
 *  - `screener`: the AI screener, in the restricted turn the server started.
 *  - `employee`: an AI Employee through its own Recruiting tools.
 *  - `member`: a person, from the Application page.
 */
export type ScorecardAuthorKind = "screener" | "employee" | "member";

/** One evidence quote, and whether the server found it in the application. */
export type ScorecardEvidence = { quote: string; found: boolean };

export type ScorecardRating = {
  criterionId: string;
  /** The criterion as it was when this was written. */
  name: string;
  importance: string;
  rating: number | null;
  evidence: ScorecardEvidence[];
  /** One sentence on why this rating. */
  note: string;
};

/**
 * One reading of an Application against its Opening's criteria.
 *
 * The author rates each criterion and quotes the evidence; the server computes
 * the score and label from those ratings (`shared/recruiting.ts`) and checks
 * every quote against the application's own text. A quote the server cannot
 * find is kept and marked, so a person sees exactly which claims rest on
 * something the candidate wrote and which do not.
 *
 * Append-only: a re-score is a new Scorecard, so the history of who thought
 * what, and against which criteria (`criteriaFingerprint`), is never rewritten.
 */
@Entity("recruiting_scorecards")
@Index(["applicationId", "createdAt"])
@Index(["companyId", "createdAt"])
export class RecruitingScorecard {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  openingId!: string;

  @Column({ type: "varchar" })
  applicationId!: string;

  @Column({ type: "varchar" })
  authorKind!: ScorecardAuthorKind;

  @Column({ type: "varchar", nullable: true })
  authorEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  /** The author's name when it was written, so a deleted author still reads. */
  @Column({ type: "varchar", default: "" })
  authorName!: string;

  @Column({ type: "integer", nullable: true })
  score!: number | null;

  @Column({ type: "varchar", nullable: true })
  label!: ScoreLabel | null;

  @Column({ type: "varchar", default: "" })
  criteriaFingerprint!: string;

  /** Evidence quotes the server could not find in the application. */
  @Column({ type: "integer", default: 0 })
  unverifiedQuotes!: number;

  /** The application addressed the screener with instructions of its own. */
  @Column({ type: "boolean", default: false })
  injectionDetected!: boolean;

  /** Which AI Model produced it, for an AI author: "Claude Sonnet 4.5". */
  @Column({ type: "varchar", default: "" })
  modelLabel!: string;

  @CreateDateColumn()
  createdAt!: Date;

  /** Two or three plain sentences for a busy reader. */
  @Column({ type: "text", default: "" })
  summary!: string;

  /** `ScorecardRating[]`, in the Opening's criteria order. */
  @Column({ type: "text", default: "[]" })
  ratingsJson!: string;

  @Column({ type: "text", default: "[]" })
  strengthsJson!: string;

  @Column({ type: "text", default: "[]" })
  concernsJson!: string;

  /** Questions worth asking in an interview, to settle what the application left open. */
  @Column({ type: "text", default: "[]" })
  interviewQuestionsJson!: string;
}
