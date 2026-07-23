import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type SequenceStatus = "draft" | "active" | "paused" | "archived";

export const SEQUENCE_STATUSES: SequenceStatus[] = [
  "draft",
  "active",
  "paused",
  "archived",
];

/**
 * When a Sequence is allowed to send, in the *contact's* working hours.
 *
 * `days` is 0-6 with 0 = Sunday, matching `Date#getUTCDay` and cron. An empty
 * list means "never send", which is a legitimate way to freeze a sequence
 * without pausing it. `startHour` > `endHour` describes a window that crosses
 * midnight; `startHour === endHour` is treated as never, not as all day,
 * because "09:00 to 09:00" is far more likely to be a mistake than a request
 * to mail around the clock.
 */
export type SendWindow = {
  days: number[];
  startHour: number;
  endHour: number;
  /** IANA zone. Resolved with Intl, so DST is handled by the platform. */
  timezone: string;
};

/**
 * Conservative default: weekdays, 08:00-17:00, UTC. A sequence that mails at
 * 3am reads as automated even when the copy is perfect.
 */
export const DEFAULT_SEND_WINDOW: SendWindow = {
  days: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 17,
  timezone: "UTC",
};

/**
 * A multi-step outbound campaign, written by an AI Employee. See ROADMAP.md M32.
 *
 * The differentiator over a mail-merge tool is `employeeId` plus `brief`: every
 * touch is drafted individually by that employee, from that contact's real
 * context — prior threads on the timeline, the open Deal, the Signal that
 * triggered enrolment, whatever Resources it has been granted — rather than
 * interpolated from a template. That is why a Sequence names an employee and a
 * standing instruction instead of holding message bodies.
 *
 * **`autoSend` is the dangerous flag.** Off (the default), every drafted touch
 * lands in the Drafts review queue and a human presses Send — the queue built
 * for exactly this in the mail milestone. On, it requires *two* independent
 * grants: the employee's revenue grant at `send`, and the mail account grant at
 * `send`. Two locks, because this is the one switch that spends the company's
 * sending reputation without a human in the loop.
 *
 * Sends are additionally gated by the suppression list, the send window, and
 * `dailyCap` — none of which `autoSend` bypasses.
 */
@Entity("sequences")
@Index(["companyId", "slug"], { unique: true })
@Index(["companyId", "status"])
@Index(["companyId", "employeeId"])
export class Sequence {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  slug!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "varchar", default: "draft" })
  status!: SequenceStatus;

  /** The mailbox every touch is sent from. */
  @Column({ type: "varchar" })
  mailAccountId!: string;

  /** The AI Employee that writes each touch. */
  @Column({ type: "varchar" })
  employeeId!: string;

  /**
   * The standing instruction handed to the employee on every step: who this is
   * for, what we sell, what good looks like, what never to say. Markdown, and
   * the single highest-leverage field in the whole entity.
   */
  @Column({ type: "text", default: "" })
  brief!: string;

  /**
   * Send without a human pressing the button. Requires revenue grant `send`
   * **and** mail grant `send`; re-checked at send time, not just at save time.
   */
  @Column({ type: "boolean", default: false })
  autoSend!: boolean;

  /** Stop the enrolment the moment they reply. Off is almost always wrong. */
  @Column({ type: "boolean", default: true })
  stopOnReply!: boolean;

  /** Max touches per day across the whole sequence. 0 = no sequence-level cap. */
  @Column({ type: "int", default: 50 })
  dailyCap!: number;

  /** Serialized {@link SendWindow}. */
  @Column({ type: "text", nullable: true })
  sendWindowJson!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  archivedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  createdById!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByEmployeeId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
