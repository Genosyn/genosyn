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
 * A persisted chat thread between a human and an AI employee. One employee
 * has many conversations; each conversation has many {@link ConversationMessage}
 * rows in chronological order.
 *
 * `title` is derived from the first user message on first send — NULL until
 * then so empty-and-abandoned conversations render as "New conversation".
 *
 * Most conversations originate in direct AI Employee chat (`source = "web"`).
 * The in-app Help surface uses `source = "help"` so its Genosyn-specific
 * context and history stay separate from ordinary employee conversations.
 * External chat surfaces — Telegram today, Slack/Discord later — set
 * `source` to a provider id and `externalKey` to whatever id uniquely
 * identifies the upstream thread (Telegram chat id, Slack channel id, …).
 * `connectionId` points at the {@link IntegrationConnection} the message
 * came in through, so multiple bots on the same provider don't collide.
 */
export type ConversationSource = "web" | "help" | "telegram";

@Entity("conversations")
@Index(["source", "connectionId", "externalKey"], {
  unique: true,
  where: '"externalKey" IS NOT NULL',
})
export class Conversation {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  employeeId!: string;

  /**
   * Member who owns a direct web/help thread. Keeping transcripts private to
   * their requester prevents a lower-privilege Member from replaying context
   * produced under somebody else's authority. External conversations have no
   * Genosyn Member and leave this NULL.
   */
  @Index()
  @Column({ type: "varchar", nullable: true })
  ownerUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  title!: string | null;

  /**
   * Set when a human archives the thread from the sidebar. Archived
   * conversations are hidden from the default list but kept intact so
   * they can be restored without data loss.
   */
  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  /** Origin/surface of the thread. `web` is direct chat, `help` is the
   * Genosyn Help surface, and everything else is routed via an Integration. */
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

  /**
   * The {@link MemberBrowser} this thread's browser work runs in, or NULL for
   * the App-owned headless Chromium. Set by the human from the chat header;
   * there is deliberately no model-facing tool for it, because choosing whose
   * signed-in browser to drive is a delegation of authority, not a step.
   *
   * Only the thread's `ownerUserId` may point it at a browser, and only at one
   * they own.
   */
  @Column({ type: "varchar", nullable: true })
  memberBrowserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
