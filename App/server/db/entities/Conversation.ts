import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * A persisted chat thread between a human and an AI employee. One employee
 * has many conversations; each conversation has many {@link ConversationMessage}
 * rows in chronological order.
 *
 * `title` is derived from the first user message on first send — NULL until
 * then so empty-and-abandoned conversations render as "New conversation".
 *
 * Most conversations originate in the Genosyn web app (`source = "web"`).
 * External chat surfaces — Telegram today, Slack/Discord later — set
 * `source` to a provider id and `externalKey` to whatever id uniquely
 * identifies the upstream thread (Telegram chat id, Slack channel id, …).
 * `connectionId` points at the {@link IntegrationConnection} the message
 * came in through, so multiple bots on the same provider don't collide.
 */
export type ConversationSource = "web" | "telegram";

@Entity("conversations")
@Index(["source", "connectionId", "externalKey"], { unique: true, where: "\"externalKey\" IS NOT NULL" })
export class Conversation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  @Column({ type: "varchar", nullable: true })
  title!: string | null;

  /**
   * Set when a human archives the thread from the sidebar. Archived
   * conversations are hidden from the default list but kept intact so
   * they can be restored without data loss.
   */
  @Column({ type: "datetime", nullable: true })
  archivedAt!: Date | null;

  /** Origin of the thread. `web` is the Genosyn UI; everything else is an
   * external chat surface routed in via an integration. */
  @Column({ type: "varchar", default: "web" })
  source!: ConversationSource;

  /** Upstream identifier — Telegram chat id, Slack channel id, etc. NULL
   * for `web` conversations. Combined with `source` + `connectionId` to
   * dedupe inbound messages onto the same thread. */
  @Column({ type: "varchar", nullable: true })
  externalKey!: string | null;

  /** {@link IntegrationConnection} this thread belongs to. NULL for `web`
   * conversations. Different bots / workspaces get separate threads even
   * when chatting with the same external user. */
  @Column({ type: "varchar", nullable: true })
  connectionId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
