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
 * A group discussion: several AI Employees working one Member's question out
 * together in a Workspace channel, in bounded rounds, ending with an outcome
 * handed back to that Member — a summary, a recommendation, open questions,
 * and who will do what.
 *
 * The talk itself is ordinary {@link ChannelMessage} rows carrying this row's
 * id (`discussionId`), so the channel stays the one transcript and every
 * surface that reads a channel reads the discussion too. This row holds what
 * the messages cannot: who takes part and in which order, which round it is,
 * the budgets it runs under, why it ended, and the structured outcome.
 *
 * A discussion talks; it does not act. Every turn runs read-only, with the
 * Grants of the AI Employee speaking intersected with the access of the
 * Member who started it (`startedByUserId`, re-checked against
 * `requesterSessionVersion` before every turn). Work the outcome assigns
 * starts only when a Member presses "Start the work", as ordinary chat turns
 * with every gate those already meet. See `services/groupDiscussions.ts`.
 */
export type GroupDiscussionStatus =
  /** Turns are being taken, or the outcome is being written (`phase`). */
  | "running"
  /** Ended with a written outcome. */
  | "concluded"
  /** A Member pressed Stop, a Standdown landed, or access changed. */
  | "stopped"
  /** Ended without an outcome: nobody could speak, or nobody could write it. */
  | "failed"
  /** The server restarted mid-discussion. Posting again picks it up. */
  | "interrupted";

export type GroupDiscussionPhase = "discussing" | "concluding" | "done";

export type GroupDiscussionEndReason =
  | "converged"
  | "max_rounds"
  | "turn_budget"
  | "usage_budget"
  | "time_limit"
  | "repetition"
  | "wrapped_up"
  | "stopped"
  | "standdown"
  | "access_changed"
  | "channel_archived"
  | "no_participants"
  | "restart"
  | "error";

@Entity("group_discussions")
@Index(["channelId", "createdAt"])
@Index(["status", "heartbeatAt"])
export class GroupDiscussion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  channelId!: string;

  /**
   * The Member whose authority every turn runs under. Null only once that
   * Member's account is deleted — history survives, and a discussion still
   * running stops at its next turn because the authority is gone.
   */
  @Column({ type: "varchar", nullable: true })
  startedByUserId!: string | null;

  /** Auth epoch accepted with the start; a password reset ends the discussion. */
  @Column({ type: "integer", default: 0 })
  requesterSessionVersion!: number;

  /** The Member's message the discussion answers. */
  @Column({ type: "varchar", nullable: true })
  questionMessageId!: string | null;

  @Column({ type: "text", default: "" })
  question!: string;

  /** AI Employee ids in speaking order. The first is the lead. */
  @Column({ type: "text", default: "[]" })
  participantsJson!: string;

  /** Who writes the outcome. Falls back down the roster when it cannot. */
  @Column({ type: "varchar", nullable: true })
  leadEmployeeId!: string | null;

  @Column({ type: "varchar", default: "running" })
  status!: GroupDiscussionStatus;

  @Column({ type: "varchar", default: "discussing" })
  phase!: GroupDiscussionPhase;

  @Column({ type: "varchar", nullable: true })
  endReason!: GroupDiscussionEndReason | null;

  /** Plain-language detail for the end, e.g. the Standdown's reason. */
  @Column({ type: "varchar", length: 500, nullable: true })
  endDetail!: string | null;

  /** Current round, 1-based. Zero until the first turn starts. */
  @Column({ type: "integer", default: 0 })
  round!: number;

  @Column({ type: "integer", default: 3 })
  maxRounds!: number;

  @Column({ type: "integer", default: 0 })
  turnsTaken!: number;

  @Column({ type: "integer", default: 0 })
  maxTurns!: number;

  /** Provider-reported tokens across every turn, the outcome included. */
  @Column({ type: "integer", default: 0 })
  tokensUsed!: number;

  @Column({ type: "integer", default: 0 })
  tokenBudget!: number;

  /** Who is taking a turn right now, or writing the outcome. */
  @Column({ type: "varchar", nullable: true })
  currentEmployeeId!: string | null;

  /** Round bookkeeping: who spoke, passed, was addressed or sat out. */
  @Column({ type: "text", default: "{}" })
  stateJson!: string;

  /**
   * Some turn read outside content (a web page). Work started from the
   * outcome starts tainted, so its sinks still queue for review.
   */
  @Column({ type: "boolean", default: false })
  tainted!: boolean;

  @Column({ type: dateTimeColumnType, nullable: true })
  stopRequestedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  stopRequestedByUserId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  wrapUpRequestedAt!: Date | null;

  /** Refreshed while a process drives the discussion; stale means it died. */
  @Column({ type: dateTimeColumnType, nullable: true })
  heartbeatAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  outcomeMessageId!: string | null;

  /** The structured outcome. Null until one is written. */
  @Column({ type: "text", nullable: true })
  outcomeJson!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  followThroughStartedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  followThroughByUserId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  endedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
