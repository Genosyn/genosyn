import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * One question this company always wants answered about every briefing.
 *
 * A `TldrQuestion` card is a question somebody asked once, about one brief. A
 * standing question is the company's opinion that a question is worth asking
 * *every* time — "what should we stop doing?" is not news about one Tuesday,
 * it is a habit. Configured once at TLDR settings, answered automatically as
 * its own card the moment a brief is posted, so the answer is waiting when the
 * brief is read rather than being something a human has to remember to ask.
 *
 * Standing questions apply forward only. Adding one never back-fills briefs
 * that have already been posted and read.
 */
@Entity("tldr_standing_questions")
@Index(["companyId", "position"])
export class TldrStandingQuestion {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The question itself, exactly as it will title the card it produces. */
  @Column({ type: "text", default: "" })
  prompt!: string;

  /**
   * Off keeps the question and its wording without answering it on the next
   * brief — the alternative to deleting a question somebody spent time on
   * just to quieten one noisy week.
   */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /** Display and answering order. Cards appear under the brief in this order. */
  @Column({ type: "int", default: 0 })
  position!: number;

  /** Null once the configuring Member's account is deleted; the question stays. */
  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
