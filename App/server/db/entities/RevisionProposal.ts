import { dateTimeColumnType } from "./columnTypes.js";
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * What the proposal wants to rewrite:
 *  - `soul`             — the employee's own constitution (`AIEmployee.soulBody`)
 *  - `skill`            — one of the employee's playbooks (`Skill.body`)
 *  - `routine_body`     — a Routine's markdown brief (`Routine.body`)
 *  - `routine_criteria` — a Routine's acceptance criteria
 *                         (`Routine.acceptanceCriteria`)
 */
export type RevisionProposalKind = "soul" | "skill" | "routine_body" | "routine_criteria";

/** Mirrors `FinanceProposalStatus`: pending until a human acts; a dispatch
 * failure leaves the row pending with `errorMessage` set. */
export type RevisionProposalStatus = "pending" | "applied" | "rejected";

/**
 * A **Revision proposal** — M50's deferred "Approval-gated self-modification"
 * made concrete on the `FinanceProposal` maker-checker spine (M52). An AI
 * Employee stages a full replacement body for its own Soul, one of its
 * Skills, or one of its Routines, with a rationale and the Runs it cites as
 * evidence. Nothing changes until an owner/admin applies it from the review
 * queue; apply re-checks that the target has not drifted since the proposal
 * was written, so a human's concurrent edit is never silently overwritten.
 *
 * Deliberately not an `Approval` (this is the employee's idea, and applying
 * writes prose rather than replaying a held action) and not a `Decision`
 * (there are no options — there is a concrete diff). See AGENTS.md §3 and
 * Decisions log #11 for why those stay separate primitives.
 */
@Entity("revision_proposals")
@Index(["companyId", "status"])
export class RevisionProposal {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The employee whose surface is being revised — always the proposer too:
   * an employee may only propose edits to its own Soul, Skills, and
   * Routines. */
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar" })
  kind!: RevisionProposalKind;

  /** The Skill or Routine id for those kinds; null for `soul`, whose target
   * is the employee itself. */
  @Column({ type: "varchar", nullable: true })
  targetId!: string | null;

  /** Display snapshot of the target's name at proposal time, so the queue
   * stays legible after a rename or delete. */
  @Column({ type: "varchar", default: "" })
  targetLabel!: string;

  /** The body the proposal was written against. Apply refuses when the live
   * body no longer matches — the reviewer approved a diff, not a blind
   * overwrite, and drift means somebody else edited meanwhile. */
  @Column({ type: "text", default: "" })
  baseBody!: string;

  /** The full replacement body. Whole-body rather than a patch format so the
   * reviewer reads exactly what will be stored, byte for byte. */
  @Column({ type: "text", default: "" })
  proposedBody!: string;

  /** Why, in the employee's words — shown beside the diff in the queue. */
  @Column({ type: "text", default: "" })
  rationale!: string;

  /** JSON array of Run ids the employee cites as evidence. Ids only; the
   * queue links them to their Run logs. */
  @Column({ type: "text", default: "[]" })
  evidenceRunIdsJson!: string;

  @Column({ type: "varchar", default: "pending" })
  status!: RevisionProposalStatus;

  /** Why the last apply attempt could not complete (drift, deleted target).
   * The row stays pending so the reviewer sees the reason in place. */
  @Column({ type: "text", default: "" })
  errorMessage!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  decidedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  decidedByUserId!: string | null;

  /** The reviewer's note on apply or reject, audited with the decision. */
  @Column({ type: "text", default: "" })
  reviewNote!: string;

  /** The stall sweep's exactly-once claim — same mechanism as Approvals and
   * Decisions: a proposal pending past the threshold re-pages owners once. */
  @Column({ type: dateTimeColumnType, nullable: true })
  stallRemindedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
