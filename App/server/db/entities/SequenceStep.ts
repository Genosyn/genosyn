import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

/**
 * One touch in a {@link Sequence}. See ROADMAP.md M32.
 *
 * Holds an *instruction*, not a message body. The AI Employee writes the actual
 * email at send time from this instruction plus the contact's live context, so
 * step 3 can legitimately say "reference whatever they replied to in step 2"
 * — something a template engine cannot express.
 *
 * `delayDays` / `delayHours` are measured from the previous step's send, not
 * from enrolment, so pausing a sequence does not bunch every pending touch into
 * the moment it resumes.
 */
@Entity("sequence_steps")
@Index(["sequenceId", "sortOrder"])
export class SequenceStep {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Denormalized for tenant-scoped sweeps. */
  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  sequenceId!: string;

  /** 0-based position. The step actually sent is chosen by this, not by id. */
  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  /** Shown in the builder so a human can scan the ladder. */
  @Column({ type: "varchar", default: "" })
  name!: string;

  /** Wait this long after the previous touch before drafting this one. */
  @Column({ type: "int", default: 3 })
  delayDays!: number;

  @Column({ type: "int", default: 0 })
  delayHours!: number;

  /** What this specific touch should accomplish. Markdown. */
  @Column({ type: "text", default: "" })
  instruction!: string;

  /**
   * Reply inside the previous touch's thread instead of starting a new one.
   * True for follow-ups (a bare "just bumping this" with no quoted history
   * reads as spam), false for a genuinely new angle.
   */
  @Column({ type: "boolean", default: true })
  threadWithPrevious!: boolean;
}
