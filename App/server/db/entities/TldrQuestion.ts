import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** Whether a Member asked this card, or a standing question produced it. */
export type TldrQuestionOrigin = "member" | "standing";

/**
 * One question a Member asked about a TLDR — its own card beside the brief,
 * never folded into the generated recap. Each card owns an independent
 * conversation with the AI Employee who wrote the briefing, so "what should we
 * stop doing?" and "what can be improved?" stay legible side by side instead
 * of turning into one rolling thread.
 *
 * A card is either asked by a Member about one brief, or produced from a
 * standing question the company configured once and every brief answers. Both
 * read the same way; {@link origin} is what lets the card say which it is.
 *
 * The answering employee is pinned when the card is created. A later writer
 * change re-points future TLDRs, but never re-attributes an answer somebody
 * already read.
 */
@Entity("tldr_questions")
@Index(["companyId", "tldrId", "createdAt"])
export class TldrQuestion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  tldrId!: string;

  /** Null after the pinned employee is deleted; the card stays readable. */
  @Column({ type: "varchar", nullable: true })
  employeeId!: string | null;

  /** The question this card is titled with. */
  @Column({ type: "text", default: "" })
  prompt!: string;

  /**
   * Who wanted this asked: a Member typing it here, or the company's standing
   * question list answering itself when the brief landed.
   */
  @Column({ type: "varchar", default: "member" })
  origin!: TldrQuestionOrigin;

  /**
   * The standing question this card came from, for cards that have one.
   *
   * Kept nullable and never enforced: deleting a standing question must not
   * take the answers it already produced with it, and {@link origin} is what
   * the card reads itself by, so a dangling pointer costs nothing.
   */
  @Column({ type: "varchar", nullable: true })
  standingQuestionId!: string | null;

  /**
   * The seeded `user` row carrying {@link prompt}. The card header already
   * shows the question, so the thread hides this row rather than printing the
   * same sentence twice.
   */
  @Column({ type: "varchar", nullable: true })
  promptMessageId!: string | null;

  /** Null once the asking Member's account is deleted; the card survives. */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
