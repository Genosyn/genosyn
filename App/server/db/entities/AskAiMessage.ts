import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { dateTimeColumnType } from "./columnTypes.js";

export type AskAiMessageStatus = "queued" | "working" | "ok" | "skipped" | "error";

/**
 * One turn in an {@link AskAiConversation}.
 *
 * A human turn may address several AI Employees at once (`@a @b`). Each one
 * answers in its own assistant row, in the order they were tagged, and later
 * answers can read the earlier ones. All of those rows are written the moment
 * the human turn is accepted — the first `working`, the rest `queued` — so a
 * browser that loses the stream can tell exactly how many answers are still
 * owed, instead of guessing whether another employee is about to start.
 *
 * `createdAt` is assigned by the service rather than the database: SQLite's
 * `datetime('now')` has one-second resolution, and a turn writes several rows
 * inside one second that must still read back in order.
 */
@Entity("ask_ai_messages")
@Index(["companyId"])
@Index(["conversationId", "createdAt"])
@Index(["contextKind", "contextId"])
export class AskAiMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  conversationId!: string;

  @Column({ type: "varchar" })
  role!: "user" | "assistant";

  /** On assistant rows, the human turn that asked for this answer. */
  @Column({ type: "varchar", nullable: true })
  turnId!: string | null;

  /** The employee that answered (assistant rows only). */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /** The AI Model the answer ran on, resolved when the turn was accepted. */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  @Column({ type: "text", default: "" })
  content!: string;

  /** Null on human rows. `queued` and `working` are both still owed. */
  @Column({ type: "varchar", nullable: true })
  status!: AskAiMessageStatus | null;

  /** JSON MessageAction[] — what the employee did this turn. */
  @Column({ type: "text", default: "" })
  actionsJson!: string;

  /** JSON one-click suggestions the employee staged (e.g. on an email). */
  @Column({ type: "text", default: "" })
  suggestionsJson!: string;

  /**
   * Human rows: the page context snapshot the turn was sent with — the path,
   * the page label, and each resolved record's kind, id, label and access
   * gate. Assistant rows: the gates of every record whose contents this
   * employee was shown, so a later employee without those Grants is never
   * replayed an answer that may quote them.
   */
  @Column({ type: "text", default: "" })
  contextJson!: string;

  /**
   * The primary record of the turn, denormalized for lookups that must not
   * parse JSON. On an assistant row it is set only when that employee was
   * shown the record, and an answer shown a Routine or one of its Runs records
   * the Routine — that is how a successful answer becomes the employee's
   * participation in someone else's Routine (`services/routineParticipation.ts`).
   */
  @Column({ type: "varchar", nullable: true })
  contextKind!: string | null;

  @Column({ type: "varchar", nullable: true })
  contextId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @Column({ type: dateTimeColumnType })
  createdAt!: Date;
}
