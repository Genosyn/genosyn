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

@Entity("channel_messages")
@Index(["channelId", "createdAt"])
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

  @Column({ type: "text", default: "" })
  content!: string;

  @Column({ type: "varchar", nullable: true })
  parentMessageId!: string | null;

  /** Set when a human edits their own message. Null means "original". */
  @Column({ type: "datetime", nullable: true })
  editedAt!: Date | null;

  /**
   * Soft-delete timestamp. We keep the row so reactions/threads don't
   * dangle — the UI renders "this message was deleted" placeholder text.
   */
  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
