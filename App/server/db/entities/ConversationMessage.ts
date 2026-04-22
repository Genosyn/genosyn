import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * One turn in a {@link Conversation}. `role` is `user` for humans and
 * `assistant` for the AI employee. `status` mirrors the chat service's result
 * shape so the UI can render skipped/error turns distinctly — NULL on user
 * messages, one of `ok`/`skipped`/`error` on assistant replies.
 */
export type ConversationMessageRole = "user" | "assistant";
export type ConversationMessageStatus = "ok" | "skipped" | "error";

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
