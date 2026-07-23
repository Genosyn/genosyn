import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * What happened. Kinds are grouped by who produces them:
 *
 * - **Mail sync** — `email_in`, `email_out`. Written automatically when a
 *   thread's participants match a known Contact. These are the majority of
 *   rows and the reason the timeline fills itself.
 * - **Deal lifecycle** — `deal_created`, `stage_change`, `deal_won`,
 *   `deal_lost`. Written by the deal service; `stage_change` is what the
 *   funnel report reads to compute stage-to-stage conversion.
 * - **Outbound** — `enrollment`, `sequence_step`, `unsubscribe`, `bounce`.
 * - **Signals** — `signal`, when a product-usage trigger fires on a Contact.
 * - **Human** — `note`, `call`, `meeting`, `task`. Logged by hand.
 */
export type ActivityKind =
  | "email_in"
  | "email_out"
  | "call"
  | "meeting"
  | "note"
  | "task"
  | "deal_created"
  | "stage_change"
  | "deal_won"
  | "deal_lost"
  | "enrollment"
  | "sequence_step"
  | "unsubscribe"
  | "bounce"
  | "signal";

export const ACTIVITY_KINDS: ActivityKind[] = [
  "email_in",
  "email_out",
  "call",
  "meeting",
  "note",
  "task",
  "deal_created",
  "stage_change",
  "deal_won",
  "deal_lost",
  "enrollment",
  "sequence_step",
  "unsubscribe",
  "bounce",
  "signal",
];

/** Body text cap. Generous enough for an email, small enough that a busy */
/** timeline query stays cheap. Longer bodies live on the MailMessage. */
export const ACTIVITY_BODY_CAP = 8_000;

/**
 * One event on a Contact / Deal / Customer timeline. See ROADMAP.md M32.
 *
 * This is append-only and the single most valuable table in the revenue
 * section, because almost nobody types into it. Mail sync matches thread
 * participants against `contacts.email` and writes `email_in` / `email_out`
 * rows on its own, so opening a Contact shows every conversation you have ever
 * had with that person without anyone doing data entry. That property is the
 * whole reason a CRM becomes load-bearing rather than abandoned.
 *
 * All three subject FKs are nullable and independent: an email to a person with
 * no open deal has only `contactId`; a stage change has only `dealId`; an
 * invoice event has only `customerId`. Denormalizing all three (rather than
 * walking Contact → Customer at read time) is what lets the account timeline be
 * one indexed query instead of a fan-out.
 *
 * No `@UpdateDateColumn`: activities are facts about the past. Correcting one
 * means writing another. `occurredAt` is separate from `createdAt` because a
 * backfilled email happened long before we recorded it, and the timeline must
 * sort by when it happened.
 */
@Entity("activities")
@Index(["companyId", "occurredAt"])
@Index(["companyId", "kind"])
@Index(["contactId", "occurredAt"])
@Index(["dealId", "occurredAt"])
@Index(["customerId", "occurredAt"])
@Index(["companyId", "mailMessageId"])
export class Activity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  kind!: ActivityKind;

  /** One line, rendered as the timeline row title. */
  @Column({ type: "varchar", default: "" })
  subject!: string;

  /** Capped at {@link ACTIVITY_BODY_CAP} by the service, never by the DB. */
  @Column({ type: "text", default: "" })
  bodyText!: string;

  /** When it happened — not when we found out. Backfills depend on this. */
  @Column({ type: dateTimeColumnType })
  occurredAt!: Date;

  @Column({ type: "varchar", nullable: true })
  contactId!: string | null;

  @Column({ type: "varchar", nullable: true })
  dealId!: string | null;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  /** Set on mail-derived rows so the timeline can deep-link into the thread. */
  @Column({ type: "varchar", nullable: true })
  mailThreadId!: string | null;

  /**
   * Set on mail-derived rows. Also the idempotency key: the sync backfill uses
   * it to avoid writing a second Activity for a message it already saw.
   */
  @Column({ type: "varchar", nullable: true })
  mailMessageId!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorUserId!: string | null;

  @Column({ type: "varchar", nullable: true })
  actorEmployeeId!: string | null;

  /** Kind-specific detail — `{fromStage,toStage}`, signal payload, and so on. */
  @Column({ type: "text", nullable: true })
  metaJson!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
