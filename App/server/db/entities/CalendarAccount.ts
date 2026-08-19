import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export type CalendarAccountStatus = "active" | "paused" | "error";
export type CalendarSyncState = "idle" | "queued" | "running" | "succeeded" | "failed";

/**
 * Which meetings the notetaker joins without being asked.
 *
 * `off` is the default and stays the default. A recorder that turns itself on
 * is the one behaviour in this whole milestone that can embarrass a company,
 * because the people on the other end did not agree to anything and the first
 * they hear of it is a bot in the participant list. So joining is opt-in per
 * calendar, and even then only for the shapes below:
 *
 *   - `external` — meetings with at least one attendee outside the company's
 *     own domains. The sales-call case, which is the one worth recording.
 *   - `all` — every meeting with a conference link, internal ones included.
 */
export type CalendarAutoRecord = "off" | "external" | "all";

export const CALENDAR_AUTO_RECORD_MODES: CalendarAutoRecord[] = ["off", "external", "all"];

/**
 * One calendar connected to the Meetings section (M44).
 *
 * Like {@link MailAccount}, this holds no credentials: it points at a `google`
 * IntegrationConnection whose consent included the Calendar scope group and
 * borrows that connection's token lifecycle. Deleting the account removes the
 * local mirror (events, meetings, transcripts, grants) and leaves the
 * Connection alone — Drive or Gmail may still be using it.
 *
 * Sync state lives here. `syncToken` is Google's incremental cursor: a pass
 * hands it back and receives only what changed since. Google expires tokens
 * (410 GONE) whenever it feels the window is too old, which is not an error
 * but an instruction to re-list the window from scratch — `services/meetings/
 * calendarSync.ts` handles that by clearing this column and retrying once.
 *
 * `windowDays` bounds what is mirrored at all. A calendar is unbounded in both
 * directions and nobody needs 2009's standups locally; the sync walks a moving
 * window and lets everything outside it fall off.
 */
@Entity("calendar_accounts")
@Index(["companyId"])
@Index(["connectionId", "calendarId"], { unique: true })
export class CalendarAccount {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The `google` IntegrationConnection whose token this calendar uses. */
  @Column({ type: "varchar" })
  connectionId!: string;

  /** Google's calendar id — `primary`, or a shared calendar's address. */
  @Column({ type: "varchar", default: "primary" })
  calendarId!: string;

  /** The account address, from the calendar list entry at connect time. */
  @Column({ type: "varchar", default: "" })
  address!: string;

  /** What the calendar calls itself, shown in the picker. */
  @Column({ type: "varchar", default: "" })
  displayName!: string;

  /** IANA zone reported by Google. Used to render all-day events honestly. */
  @Column({ type: "varchar", default: "" })
  timeZone!: string;

  @Column({ type: "varchar", default: "active" })
  status!: CalendarAccountStatus;

  /** Human-readable reason when `status` is `error`. */
  @Column({ type: "varchar", default: "" })
  statusMessage!: string;

  /** Google's incremental cursor. Empty forces a full window re-list. */
  @Column({ type: "varchar", default: "" })
  syncToken!: string;

  @Column({ type: "varchar", default: "idle" })
  syncState!: CalendarSyncState;

  /** Random id returned by a manual sync request so concurrent callers
   * coalesce onto one pass and observe the same id. */
  @Column({ type: "varchar", nullable: true })
  syncAttemptId!: string | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  syncStartedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  syncFinishedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  lastSyncAt!: Date | null;

  /** How far either side of today the local mirror reaches, in days. */
  @Column({ type: "int", default: 60 })
  windowDays!: number;

  @Column({ type: "varchar", default: "off" })
  autoRecord!: CalendarAutoRecord;

  /** The AI Employee that owns auto-recorded meetings: it is the one whose
   * grants the follow-up turn runs under. Null disables auto-recording no
   * matter what `autoRecord` says — there is nobody to do the work. */
  @Column({ type: "varchar", nullable: true })
  notetakerEmployeeId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
