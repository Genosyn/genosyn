import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One AI Employee's turn in a Workspace channel, DM or group chat — the
 * answer to an @mention or a DM message, one speaker's turn in a group
 * discussion, or one AI Employee's share of the work a discussion's outcome
 * started.
 *
 * A Workspace reply used to be a fire-and-forget call: a typing pill for as
 * long as the AI Model took, then a message — or nothing at all if the server
 * restarted, and a plain "unavailable" sentence when the AI Model was down.
 * This row is the turn itself, so the room can watch it: its activity is the
 * same feed a direct chat records (`ConversationActivityEvent`, written by
 * `services/chatTurnActivity.ts` and followed live through
 * `services/chatTurnFollow.ts`), keyed by this row's id and scoped to the
 * channel. The reply it writes is an ordinary {@link ChannelMessage}
 * (`replyMessageId`), so the channel stays the one transcript.
 *
 * Replies (`kind: "reply"`) are durable: a worker claims one with a short,
 * renewed lease (`workerId`, `leaseExpiresAt`), and one that is waiting — for
 * its AI Model to come back, or for another reply in the channel — stays
 * `working`, unclaimed, until its next look (`leaseExpiresAt`) or until the
 * model answers again (`services/channelTurns.ts`). A discussion turn and a
 * follow-through share are driven by the group discussion
 * (`services/groupDiscussions.ts`); their lease only says the driver is alive.
 *
 * Whose authority a turn runs under decides who may see its steps:
 * `authority` and `requesterUserId` (`shared/turnActivityAccess.ts`).
 */
export type ChannelTurnKind = "reply" | "discussion" | "follow_through";

/**
 * Whose access the turn's tools run with: the Member whose message started it,
 * the AI Employee's own (an AI colleague's @mention), or nobody's (a message
 * from an incoming webhook, which no Member wrote).
 */
export type ChannelTurnAuthority = "member" | "employee" | "untrusted";

/** `working` until it ends; then how it ended, as a chat reply's status says. */
export type ChannelTurnStatus = "working" | "ok" | "error" | "skipped" | "interrupted";

/** Why a `working` reply is not running right now. */
export type ChannelTurnWait = "model_unavailable" | "thread_busy" | "model_resuming";

/** What the next pickup of a reply is, when it is not a plain start or a restart. */
export type ChannelTurnResume = "retry" | "model_back";

@Entity("channel_turns")
@Index(["channelId", "status"])
@Index(["status", "leaseExpiresAt"])
@Index(["replyMessageId"])
@Index(["triggerMessageId"])
@Index(["discussionId"])
export class ChannelTurn {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  channelId!: string;

  /** The AI Employee taking the turn. */
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", default: "reply" })
  kind!: ChannelTurnKind;

  /** The message it answers; for a discussion turn, the discussion's question. */
  @Column({ type: "varchar", nullable: true })
  triggerMessageId!: string | null;

  /** The {@link GroupDiscussion} a discussion turn or a follow-through share belongs to. */
  @Column({ type: "varchar", nullable: true })
  discussionId!: string | null;

  /** The discussion round a discussion turn was taken in. */
  @Column({ type: "int", nullable: true })
  round!: number | null;

  @Column({ type: "varchar", default: "untrusted" })
  authority!: ChannelTurnAuthority;

  /** The Member whose authority a `member` turn runs under. */
  @Column({ type: "varchar", nullable: true })
  requesterUserId!: string | null;

  /** That Member's auth epoch when the turn was accepted, re-checked before it runs. */
  @Column({ type: "int", nullable: true })
  requesterSessionVersion!: number | null;

  @Column({ type: "varchar", default: "working" })
  status!: ChannelTurnStatus;

  /** Set while a `working` reply waits; null while it runs. */
  @Column({ type: "varchar", nullable: true })
  waitingFor!: ChannelTurnWait | null;

  @Column({ type: "varchar", nullable: true })
  resumeAs!: ChannelTurnResume | null;

  @Column({ type: "varchar", nullable: true })
  workerId!: string | null;

  /**
   * While claimed: when the claim lapses unless renewed. While a reply waits:
   * its next look. Null on a reply nobody has picked up yet (due now) and on
   * a finished turn.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  leaseExpiresAt!: Date | null;

  /** Pickups that reached the AI Model: above 1 after a restart, an outage or a Retry. */
  @Column({ type: "int", default: 0 })
  attempt!: number;

  /** When it was asked for, to the millisecond — every elapsed clock counts from here. */
  @Column({ type: dateTimeColumnType })
  acceptedAt!: Date;

  /** The six-hour limit a chat turn has, restarted when a wait for the AI Model ends. */
  @Column({ type: dateTimeColumnType, nullable: true })
  deadlineAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  endedAt!: Date | null;

  /** The Member who pressed Stop, when one did. */
  @Column({ type: "varchar", nullable: true })
  stoppedByUserId!: string | null;

  /** The {@link ChannelMessage} the turn wrote, once it has. */
  @Column({ type: "varchar", nullable: true })
  replyMessageId!: string | null;

  /**
   * Some attempt read outside content, or replayed words a tainted turn
   * wrote. The reply carries it (`ChannelMessage.tainted`).
   */
  @Column({ type: "boolean", default: false })
  tainted!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /**
   * The reply so far, saved as it streams, so a reader attached to another
   * replica — or a Stop that lands there — has the text already on screen.
   */
  @Column({ type: "text", default: "" })
  replyText!: string;

  /** "Worked for 2m 14s · 9 steps" — the turn's summary once it ended. */
  @Column({ type: "text", default: "" })
  activityJson!: string;
}
