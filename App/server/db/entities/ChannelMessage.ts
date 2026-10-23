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
 * A single message in a {@link Channel}. Distinct from
 * `ConversationMessage` which belongs to the per-employee 1:1 chat surface —
 * channel messages carry a richer author identity (human *or* AI) and can
 * address any participant in the channel.
 *
 * `parentMessageId` is nullable to support flat threads: a reply sets it to
 * the root message id; a top-level post leaves it null. We don't render a
 * split thread panel in v1 — replies just inline under the parent — but the
 * column is there so future thread UI doesn't need a migration.
 */
export type ChannelMessageAuthorKind = "user" | "ai" | "system";

/**
 * What a message is to the group discussion it belongs to:
 *
 *  - `question`       — the Member message the discussion answers;
 *  - `input`          — a Member writing into a discussion already running;
 *  - `turn`           — one AI Employee's turn;
 *  - `outcome`        — the hand-back: summary, recommendation, open
 *                       questions and who does what;
 *  - `note`           — a system line: someone was brought in, sat out, or
 *                       the discussion stopped;
 *  - `follow_through` — an AI Employee reporting on the work the outcome gave
 *                       it, after a Member pressed "Start the work".
 */
export type ChannelMessageDiscussionRole =
  | "question"
  | "input"
  | "turn"
  | "outcome"
  | "note"
  | "follow_through";

@Entity("channel_messages")
@Index(["channelId", "createdAt"])
@Index(["discussionId", "createdAt"])
export class ChannelMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  channelId!: string;

  @Column({ type: "varchar" })
  authorKind!: ChannelMessageAuthorKind;

  @Column({ type: "varchar", nullable: true })
  authorUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  authorEmployeeId!: string | null;

  /**
   * Display name for system-authored messages such as incoming webhooks.
   * Human and AI names remain sourced from their live entity rows.
   */
  @Column({ type: "varchar", nullable: true })
  authorName!: string | null;

  @Column({ type: "text", default: "" })
  content!: string;

  @Column({ type: "varchar", nullable: true })
  parentMessageId!: string | null;

  /** The {@link GroupDiscussion} this message belongs to, if any. */
  @Column({ type: "varchar", nullable: true })
  discussionId!: string | null;

  @Column({ type: "varchar", nullable: true })
  discussionRole!: ChannelMessageDiscussionRole | null;

  /**
   * Written by an AI turn that had read outside content (a web page, an
   * application). An AI turn that replays this message starts tainted, so a
   * page cannot launder instructions through a colleague's reply into a turn
   * that never read it (`services/taintPolicy.ts`).
   */
  @Column({ type: "boolean", default: false })
  tainted!: boolean;

  /** Set when a human edits their own message. Null means "original". */
  @Column({ type: dateTimeColumnType, nullable: true })
  editedAt!: Date | null;

  /**
   * Soft-delete timestamp. We keep the row so reactions/threads don't
   * dangle — the UI renders "this message was deleted" placeholder text.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
