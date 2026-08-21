import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * One question a Member asked about a TLDR — its own card beside the brief,
 * never folded into the generated recap. Each card owns an independent
 * conversation with the AI Employee who wrote the briefing, so "what should we
 * stop doing?" and "what can be improved?" stay legible side by side instead
 * of turning into one rolling thread.
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

  /** The Member-authored question this card is titled with. */
  @Column({ type: "text", default: "" })
  prompt!: string;

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
