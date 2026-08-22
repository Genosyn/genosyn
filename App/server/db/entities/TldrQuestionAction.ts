import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Kinds of work an answer can propose. The list is fixed because it decides
 * two things a free-form string could not: which icon the button wears, and
 * whether an ordinary Member is allowed to press it at all.
 *
 * `routine` is the one that is owner/admin-gated — `create_routine` and
 * `update_routine` are admin tools in `memberToolAuthority`, and a button is a
 * worse place than a settings page to discover you lacked the authority.
 */
export const TLDR_ACTION_KINDS = ["routine", "todo", "project", "decision", "other"] as const;

export type TldrActionKind = (typeof TLDR_ACTION_KINDS)[number];

/**
 * Lifecycle of one suggested action.
 *
 * `running` is durable rather than a local spinner, for the same reason the
 * card's own turns are: the click is answered by a model, and the browser that
 * pressed the button is not what the work belongs to.
 */
export type TldrActionStatus = "proposed" | "running" | "done" | "dismissed";

/**
 * One suggested next step an AI Employee attached to its own answer.
 *
 * The answer says "we should stop the nightly scrape". The action is the
 * button that makes that happen, so agreeing with a proposal costs a click
 * instead of a paragraph of re-explaining it back to the employee.
 *
 * Two fields, deliberately, and both are shown to the Member: {@link label} is
 * the button, {@link intent} is the full sentence of what pressing it will
 * ask for. Nothing hidden rides along. That matters because this text was
 * written by a model that had just read untrusted briefing content: the
 * guarantee is not that the proposal is trustworthy, it is that what the
 * Member authorizes is exactly what the Member was shown, and that running it
 * carries that Member's own authority and no more.
 */
@Entity("tldr_question_actions")
@Index(["companyId"])
@Index(["questionId", "position"])
export class TldrQuestionAction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** Denormalized so scoping and cascade deletes never need a join. */
  @Column({ type: "varchar" })
  tldrId!: string;

  @Column({ type: "varchar" })
  questionId!: string;

  /** The assistant turn that proposed this. */
  @Column({ type: "varchar" })
  messageId!: string;

  @Column({ type: "varchar", default: "other" })
  kind!: TldrActionKind;

  /** Button text. Short and imperative — "Stop it now", "Open a Todo". */
  @Column({ type: "varchar", default: "" })
  label!: string;

  /** One sentence naming exactly what pressing the button will ask for. */
  @Column({ type: "text", default: "" })
  intent!: string;

  @Column({ type: "int", default: 0 })
  position!: number;

  @Column({ type: "varchar", default: "proposed" })
  status!: TldrActionStatus;

  /** The Member turn a press created, so the thread and the button agree. */
  @Column({ type: "varchar", nullable: true })
  runMessageId!: string | null;

  /** Null once that Member's account is deleted; the completed action stays. */
  @Column({ type: "varchar", nullable: true })
  completedByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
