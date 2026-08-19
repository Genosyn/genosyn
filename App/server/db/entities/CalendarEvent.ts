import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Where the meeting actually happens. Detected from the event rather than
 * configured, because the link is a property of the invite — see
 * `services/meetings/conference.ts` for the matching.
 */
export type ConferenceProvider = "meet" | "zoom" | "teams" | "webex" | "other" | "none";

export const CONFERENCE_PROVIDERS: ConferenceProvider[] = [
  "meet",
  "zoom",
  "teams",
  "webex",
  "other",
  "none",
];

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";

/**
 * One event mirrored from a connected calendar (M44).
 *
 * A read-only local copy: the calendar stays the source of truth and every
 * write goes back through the Google Calendar tools on the Connection. What
 * this table buys is a calendar the app can *query* — "which meetings in the
 * next hour have a conference link and an outside attendee" is one indexed
 * scan here and would otherwise be an API call per pass per account.
 *
 * `externalId` is Google's event id and is unique per account, which makes it
 * the upsert key. A recurring series arrives as one row per instance because
 * the sync asks for `singleEvents=true`; `recurringEventId` ties them back
 * together so the UI can say "weekly" without expanding an RRULE itself.
 *
 * Attendees are JSON rather than rows. They are read as a set almost every
 * time, they change wholesale when an invite is updated, and the one query
 * that genuinely needs them relational — matching people to Contacts — runs
 * against {@link MeetingParticipant} on a recorded meeting instead, where the
 * link is worth persisting.
 */
@Entity("calendar_events")
@Index(["companyId", "startAt"])
@Index(["accountId", "startAt"])
@Index(["accountId", "externalId"], { unique: true })
@Index(["companyId", "iCalUid"])
export class CalendarEvent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  accountId!: string;

  /** Google's event id. Stable across edits; the upsert key. */
  @Column({ type: "varchar" })
  externalId!: string;

  /** Stable across calendars — the same meeting on two attendees' calendars
   * shares this, which is how a recorded meeting is de-duplicated. */
  @Column({ type: "varchar", default: "" })
  iCalUid!: string;

  /** Set on every instance of a recurring series. */
  @Column({ type: "varchar", default: "" })
  recurringEventId!: string;

  @Column({ type: "varchar", default: "" })
  summary!: string;

  @Column({ type: "text", default: "" })
  description!: string;

  @Column({ type: "varchar", default: "" })
  location!: string;

  @Column({ type: dateTimeColumnType })
  startAt!: Date;

  @Column({ type: dateTimeColumnType })
  endAt!: Date;

  /** All-day events carry a date with no time; the window they occupy is
   * the calendar's zone, not the server's. */
  @Column({ type: "boolean", default: false })
  allDay!: boolean;

  @Column({ type: "varchar", default: "confirmed" })
  status!: CalendarEventStatus;

  @Column({ type: "varchar", default: "" })
  organizerEmail!: string;

  @Column({ type: "varchar", default: "" })
  organizerName!: string;

  /** `[{email, displayName, responseStatus, optional, organizer, self}]`. */
  @Column({ type: "text", default: "[]" })
  attendeesJson!: string;

  @Column({ type: "varchar", default: "none" })
  conferenceProvider!: ConferenceProvider;

  @Column({ type: "varchar", default: "" })
  conferenceUrl!: string;

  /** Deep link back into Google Calendar. */
  @Column({ type: "varchar", default: "" })
  htmlLink!: string;

  /** Google's own last-modified stamp, so a re-sync can skip untouched rows. */
  @Column({ type: dateTimeColumnType, nullable: true })
  remoteUpdatedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
