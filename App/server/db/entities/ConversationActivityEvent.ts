import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import type { ChatActivityKind } from "../../../shared/chatActivity.js";
import { dateTimeColumnType } from "./columnTypes.js";

/**
 * One thing that happened while an AI Employee answered a Member in chat.
 *
 * A chat turn used to be recorded as the question and the reply, with three
 * typing dots in between: for the minutes a turn can run, a Member could not
 * tell whether the employee was searching their books, waiting on the AI
 * Model, stuck, or done. These rows are what the chat shows instead — each
 * tool call and its result, the AI Model's thinking summary when the runtime
 * exposes one, the reasons a turn waits — live while it runs and folded into
 * "Worked for 2m 14s · 9 steps" afterwards. The pattern is the Repository
 * work session's ({@link RepositoryWorkSessionEvent}), applied to chat.
 *
 * Every detail is redacted and clipped by the writer
 * (`services/chatTurnActivity.ts`) before it is stored: this is a feed of how
 * the reply came to be, never an archive of what tools returned, and it is
 * readable only by whoever can read the conversation itself. Rows are
 * append-only and read incrementally by `(messageId, ordinal)`.
 *
 * Deliberately absent from the live-sync registry: a conversation is private
 * to the Member who owns it, so nothing about it rides the company-wide
 * socket. The chat follows a running turn over its own authorized stream.
 */
@Entity("conversation_activity_events")
@Index(["messageId", "ordinal"])
@Index(["conversationId"])
@Index(["companyId"])
export class ConversationActivityEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  conversationId!: string;

  /** The assistant {@link ConversationMessage} — the turn — this belongs to. */
  @Column({ type: "varchar" })
  messageId!: string;

  /** Position in the turn, across attempts, so a reader can ask for "after N". */
  @Column({ type: "int" })
  ordinal!: number;

  /** The durable turn's attempt that recorded it: above 1 after a restart or a Retry. */
  @Column({ type: "int", default: 1 })
  attempt!: number;

  @Column({ type: "varchar" })
  kind!: ChatActivityKind;

  /** The tool for tool events, the cause for `waiting`, the code for `notice`. */
  @Column({ type: "varchar", default: "" })
  name!: string;

  /** Pairs a `tool_result` with its `tool_use`. Empty for other kinds. */
  @Column({ type: "varchar", default: "" })
  callId!: string;

  /** One redacted line a person can read: "Searched Banking transactions". */
  @Column({ type: "text", default: "" })
  summary!: string;

  /** Bounded, redacted structured detail (arguments, output, a wait's cause). */
  @Column({ type: "text", default: "" })
  detailJson!: string;

  @Column({ type: "boolean", default: false })
  isError!: boolean;

  /**
   * When it happened, to the millisecond. Set by the writer rather than left to
   * the column default, which SQLite records to the second — too coarse for a
   * step that took 400ms.
   */
  @Column({ type: dateTimeColumnType })
  occurredAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
