import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * One turn in a TLDR question card's conversation.
 *
 * Unlike a `Conversation` (which belongs to one employee and is private to the
 * Member who opened it), this thread belongs to the question card: it is
 * company-visible like the briefing it hangs off, and every turn runs against
 * the employee pinned on the card.
 *
 * The opening answer is generated on the same no-tool path the briefing itself
 * uses, so summarizing still grants no authority. Follow-ups run the ordinary
 * chat seam with the asking Member's own authority — that is where "add a
 * Routine for this" becomes a real Routine.
 */
@Entity("tldr_question_messages")
@Index(["companyId"])
@Index(["questionId", "createdAt"])
export class TldrQuestionMessage {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Denormalized so scoping and cascade deletes never need a join. */
  @Column({ type: "varchar" })
  tldrId!: string;

  @Column({ type: "varchar" })
  questionId!: string;

  @Column({ type: "varchar" })
  role!: "user" | "assistant";

  /** The employee that answered (assistant rows only). */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /**
   * The AI Model this turn actually ran on, resolved at acceptance time, for
   * the same reason the other chat surfaces persist it: reopening a card on
   * the employee's *current* active model would silently swap brains mid-thread.
   */
  @Column({ type: "varchar", nullable: true })
  modelId!: string | null;

  @Column({ type: "text", default: "" })
  content!: string;

  /**
   * Mirror of the chat seam's ChatResult status; null on user rows.
   *
   * `working` is the in-flight state: the row is persisted before the model
   * runs, so a dropped browser connection can find the turn again and follow
   * it to its real answer instead of leaving a permanent spinner on the card.
   */
  @Column({ type: "varchar", nullable: true })
  status!: "working" | "ok" | "skipped" | "error" | null;

  /** JSON MessageAction[] — what the employee actually did this turn. */
  @Column({ type: "text", default: "" })
  actionsJson!: string;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
