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
 * How one company runs Support. One row per company, made the first time it is
 * needed. Every field a person can leave alone is nullable or defaulted so a
 * company nobody configured follows the current defaults as they improve —
 * `topicsJson` and `slaJson` hold a value only once the owners change them.
 */
@Entity("support_settings")
@Index(["companyId"], { unique: true })
export class SupportSettings {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /**
   * The AI Employee who works Support where an inbox names none. An
   * appointment, not a Grant: it works only in the restricted turns the server
   * starts, which read nothing but the ticket in front of them and the
   * published Articles.
   */
  @Column({ type: "varchar", nullable: true })
  aiEmployeeId!: string | null;

  /** The number the next ticket takes. Handed out one at a time, per company. */
  @Column({ type: "int", default: 1 })
  nextTicketNumber!: number;

  /** The language summaries and notes are written in for the company's own people. */
  @Column({ type: "varchar", default: "English" })
  workingLanguage!: string;

  @Column({ type: "boolean", default: true })
  slaEnabled!: boolean;

  /** Ask customers how it went once a ticket has stayed solved. Sends mail, so opt-in. */
  @Column({ type: "boolean", default: false })
  ratingsEnabled!: boolean;

  /**
   * Whether the published Articles are readable by anyone at `/help/<company slug>`.
   * Opt-in: until an owner or admin turns it on, that path answers exactly as if
   * it never existed (`services/support/helpCenter.ts`).
   */
  @Column({ type: "boolean", default: false })
  helpCenterEnabled!: boolean;

  /** Days a solved ticket stays solved before it closes. 0 never closes one. */
  @Column({ type: "int", default: 7 })
  autoCloseDays!: number;

  /** Days a ticket waits on a silent customer before it counts as solved. 0 never does. */
  @Column({ type: "int", default: 5 })
  autoSolveDays!: number;

  @Column({ type: dateTimeColumnType, nullable: true })
  insightsAt!: Date | null;

  /** Messages the company's Chat widgets take in an hour, across all of them. */
  @Column({ type: "int", default: 600 })
  chatMessagesPerHour!: number;

  /**
   * Model turns the company's Chat widgets may start in a day, on any setting,
   * because triage and drafts cost one as much as a sent reply does. 0 is none.
   */
  @Column({ type: "int", default: 200 })
  chatAiTurnsPerDay!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  /** How to answer, in the company's own words. Only ever in the system turn. */
  @Column({ type: "text", default: "" })
  aiInstructions!: string;

  /** The line under a reply an AI Employee sent on its own. Null is the default text. */
  @Column({ type: "text", nullable: true })
  aiDisclosure!: string | null;

  /** JSON `SupportTopic[]`. Null is the default topics. */
  @Column({ type: "text", nullable: true })
  topicsJson!: string | null;

  /** JSON `SupportSlaTargets`. Null is the default targets. */
  @Column({ type: "text", nullable: true })
  slaJson!: string | null;

  /** JSON `SupportBusinessHours`. Null counts targets around the clock. */
  @Column({ type: "text", nullable: true })
  businessHoursJson!: string | null;

  /** JSON `SupportInsights`: the latest reading of recent tickets. */
  @Column({ type: "text", nullable: true })
  insightsJson!: string | null;
}
