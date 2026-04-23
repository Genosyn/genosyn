import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * A participant in a {@link Channel}. Exactly one of `userId` / `employeeId`
 * is non-null — we keep them as separate columns (rather than a polymorphic
 * `memberId` + `kind`) so foreign-key-style lookups and left-joins stay
 * straightforward.
 *
 * Public channels don't require membership rows to *read*, but we insert one
 * on first visit so we can track `lastReadAt` and render unread badges.
 */
export type ChannelMemberKind = "user" | "ai";

@Entity("channel_members")
@Index(["channelId", "userId"], { unique: true, where: "userId IS NOT NULL" })
@Index(["channelId", "employeeId"], {
  unique: true,
  where: "employeeId IS NOT NULL",
})
@Index(["userId"])
@Index(["employeeId"])
export class ChannelMember {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  channelId!: string;

  @Column({ type: "varchar" })
  memberKind!: ChannelMemberKind;

  @Column({ type: "varchar", nullable: true })
  userId!: string | null;

  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /**
   * Set when a human reads the channel. We compare it against the channel's
   * `lastMessageAt` to compute an unread badge on the sidebar without paging
   * through every message row. AI employees don't track read state.
   */
  @Column({ type: "datetime", nullable: true })
  lastReadAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
