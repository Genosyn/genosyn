import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A Slack-style group chat scoped to a {@link Company}. `kind` splits into:
 *
 *  - `public`  — every member of the company can see + join it.
 *  - `private` — visible only to explicit {@link ChannelMember} rows.
 *  - `dm`      — 1:1 conversation between two members (human or AI). Name is
 *                rendered from the members, not `name`/`slug`, so those fields
 *                stay blank.
 *
 * `slug` is unique within (companyId, kind='public'|'private') and null for
 * DMs. We keep the soft-delete pattern from conversations: `archivedAt` hides
 * the channel from default listings without losing history.
 */
export type ChannelKind = "public" | "private" | "dm";

@Entity("channels")
@Index(["companyId", "slug"], { unique: true, where: "slug IS NOT NULL" })
export class Channel {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: ChannelKind;

  @Column({ type: "varchar", nullable: true })
  name!: string | null;

  @Column({ type: "varchar", nullable: true })
  slug!: string | null;

  @Column({ type: "varchar", default: "" })
  topic!: string;

  /** userId of the human that created the channel. Null for system channels. */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  /**
   * Mirrors the most recent message's createdAt so the sidebar can sort DMs
   * and channels by recent activity without a subquery. Updated by the chat
   * service on every send.
   */
  @Column({ type: "datetime", nullable: true })
  lastMessageAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
