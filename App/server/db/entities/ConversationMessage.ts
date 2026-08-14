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
 * One turn in a {@link Conversation}. `role` is `user` for humans and
 * `assistant` for the AI employee. `status` mirrors the chat service's result
 * shape so the UI can render skipped/error/busy turns distinctly — NULL on
 * user messages, one of `working`/`ok`/`skipped`/`error`/`busy` on assistant
 * replies. `working` is a durable placeholder for a chat turn still running.
 * It lets a browser reload or a replacement connection recover the live state
 * without mistaking a dropped stream for a failed turn. `busy` means the
 * employee was already mid-Run or mid-chat, so the new turn did not start.
 */
export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "working" | "ok" | "skipped" | "error" | "busy";

@Entity("conversation_messages")
export class ConversationMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar" })
  conversationId!: string;

  @Column({ type: "varchar" })
  role!: ConversationMessageRole;

  @Column({ type: "text", default: "" })
  content!: string;

  @Column({ type: "varchar", nullable: true })
  status!: ConversationMessageStatus | null;

  /** Latest employee-authored completion estimate while `status=working`. */
  @Column({ type: "integer", nullable: true })
  progressPercent!: number | null;

  /** Short current-activity label paired with {@link progressPercent}. */
  @Column({ type: "varchar", nullable: true })
  progressLabel!: string | null;

  /**
   * AI Model selected for this durable assistant turn. NULL on user messages,
   * legacy replies, and turns accepted while the employee had no model.
   * Persisting the choice keeps recovery on the same brain even if the
   * employee's active model changes before a replacement worker resumes.
   */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  /**
   * User message that owns this durable assistant turn. NULL on ordinary
   * messages and legacy completed replies. Persisting the link makes recovery
   * unambiguous even when several messages share the same text.
   */
  @Index({ unique: true })
  @Column({ type: "varchar", nullable: true })
  turnUserMessageId!: string | null;

  /**
   * Human Member whose interactive request caused this durable turn. Recovery
   * must keep the same principal: without this field a restarted worker would
   * silently resume with the AI Employee's broader Grants. NULL is reserved
   * for legacy rows and non-human surfaces.
   */
  @Index()
  @Column({ type: "varchar", nullable: true })
  turnRequesterUserId!: string | null;

  /**
   * Auth epoch from the browser session that accepted this durable turn.
   * Recovery must present the same epoch; reading the User's newer epoch after
   * a password reset would otherwise re-authorize an old queued request.
   */
  @Column({ type: "integer", nullable: true })
  turnRequesterSessionVersion!: number | null;

  /** Current worker claim. A new process may take over after its lease expires. */
  @Column({ type: "varchar", nullable: true })
  turnWorkerId!: string | null;

  /** Short renewable claim that prevents two replicas resuming the same turn. */
  @Index()
  @Column({ type: dateTimeColumnType, nullable: true })
  turnLeaseExpiresAt!: Date | null;

  /** Number of agent attempts, including recoveries after process interruption. */
  @Column({ type: "integer", default: 0 })
  turnAttempt!: number;

  /** Absolute limit shared by every retry so restarts cannot extend work forever. */
  @Column({ type: dateTimeColumnType, nullable: true })
  turnDeadlineAt!: Date | null;

  /**
   * JSON-serialized list of {@link MessageAction}s the AI employee performed
   * during this turn (create_routine, create_todo, ...). Always empty on
   * user-role rows; on assistant rows it's an empty string when no writes
   * happened. Drawn from the AuditEvent table at message-save time.
   */
  @Column({ type: "text", default: "" })
  actionsJson!: string;

  @CreateDateColumn()
  createdAt!: Date;

  /** Changes on every persisted milestone and on final completion. */
  @UpdateDateColumn()
  updatedAt!: Date;
}

/**
 * Canonical shape for entries inside `actionsJson`. Mirrors the subset of
 * AuditEvent fields we want to render as chat action pills. Kept small so
 * reloading a long transcript stays cheap.
 */
export type MessageAction = {
  /** Dotted audit action name — e.g. `routine.create`, `todo.create`. */
  action: string;
  /** Kind of entity the action touched. */
  targetType: string;
  /** UUID of the created/updated entity, when available. */
  targetId: string | null;
  /** Human label at the time of the action — e.g. "Weekly revenue monitor". */
  targetLabel: string;
  /**
   * Optional action-specific context surfaced when the user clicks a pill.
   * For `integration.invoke` this carries provider/connection identity plus
   * an args/result preview so humans can audit exactly what the AI did.
   */
  metadata?: MessageActionMetadata;
};

export type MessageActionMetadata = {
  /** Opaque trail — how the action was recorded (`mcp`, `api`, …). */
  via?: string;
  /** Integration provider id, e.g. `metabase`, `stripe`. */
  provider?: string;
  /** IntegrationConnection row id. */
  connectionId?: string;
  /** Human-readable connection label at the time of the call. */
  connectionLabel?: string;
  /** Integration-side tool name (without provider prefix). */
  toolName?: string;
  /** Outcome of the call. */
  status?: "ok" | "error";
  /** Wall-clock time the call took, in milliseconds. */
  durationMs?: number;
  /** Pretty-printed JSON of the arguments the AI passed. Capped ~20 KB. */
  argsPreview?: string;
  /** Pretty-printed JSON of the tool response. Capped ~20 KB. */
  resultPreview?: string;
  /** Error message on failure; mutually exclusive with `resultPreview`. */
  error?: string;
};
