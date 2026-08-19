import { dateTimeColumnType } from "./columnTypes.js";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import type { ConferenceProvider } from "./CalendarEvent.js";

/**
 * The life of one recorded meeting, start to finish.
 *
 *   scheduled → joining → recording → processing → ready
 *
 * with `failed` reachable from any of them and `skipped` meaning a human (or
 * the auto-record policy) decided this one should not be recorded. The states
 * are durable rather than derived because every one of them can outlive the
 * process that set it: a restart mid-call has to be able to tell a recording
 * it lost from one that finished.
 */
export type MeetingStatus =
  | "scheduled"
  | "joining"
  | "recording"
  | "processing"
  | "ready"
  | "failed"
  | "skipped";

export const MEETING_STATUSES: MeetingStatus[] = [
  "scheduled",
  "joining",
  "recording",
  "processing",
  "ready",
  "failed",
  "skipped",
];

/**
 * Where the audio came from.
 *
 *   - `notetaker` — the built-in recorder joined the call and captured it.
 *   - `upload` — a human (or a tool) handed us a recording after the fact.
 *   - `transcript` — no audio at all; someone pasted or uploaded a transcript.
 *
 * The third exists because every deployment can use it. A notetaker needs a
 * browser that the conference will actually admit, and plenty of installs will
 * never have one; the whole downstream half of this milestone — linking,
 * summarising, follow-ups — is worth having without it.
 */
export type MeetingRecordingSource = "notetaker" | "upload" | "transcript" | "none";

export type MeetingTranscriptState = "none" | "queued" | "running" | "ready" | "failed";

/**
 * One meeting Genosyn has a record of (M44).
 *
 * Usually born from a {@link CalendarEvent} with a conference link, but not
 * always: a call that was never on a calendar can be created directly and a
 * recording dropped on it, which is why `calendarEventId` is nullable.
 *
 * The Revenue link is denormalised onto the row the same way {@link Activity}
 * denormalises its three subjects, and for the same reason — opening a
 * customer's meetings must be one indexed query. `linkedAt` records that the
 * attendee→Contact pass has run, so a re-run is a no-op rather than a second
 * set of timeline rows; `Activity.meetingId` is the actual idempotency key.
 *
 * `summaryText` and `actionItemsJson` are what the AI Employee produced, kept
 * beside the transcript rather than only as Activity rows so the meeting page
 * can render them without a join and so a failed follow-up pass can be retried
 * without re-transcribing.
 */
@Entity("meetings")
@Index(["companyId", "scheduledStartAt"])
@Index(["companyId", "status"])
@Index(["companyId", "customerId"])
@Index(["calendarEventId"], { unique: true })
export class Meeting {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  /** The mirrored event this came from. Null for an ad-hoc meeting. */
  @Column({ type: "varchar", nullable: true })
  calendarEventId!: string | null;

  /** The calendar that produced it, kept so deleting an account can sweep. */
  @Column({ type: "varchar", nullable: true })
  accountId!: string | null;

  @Column({ type: "varchar", default: "" })
  title!: string;

  @Column({ type: dateTimeColumnType, nullable: true })
  scheduledStartAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  scheduledEndAt!: Date | null;

  /** When the recorder actually joined, and actually left. */
  @Column({ type: dateTimeColumnType, nullable: true })
  startedAt!: Date | null;

  @Column({ type: dateTimeColumnType, nullable: true })
  endedAt!: Date | null;

  @Column({ type: "varchar", default: "none" })
  conferenceProvider!: ConferenceProvider;

  @Column({ type: "varchar", default: "" })
  conferenceUrl!: string;

  @Column({ type: "varchar", default: "scheduled" })
  status!: MeetingStatus;

  /** Why `status` is `failed` or `skipped`, in a sentence a human can act on. */
  @Column({ type: "varchar", default: "" })
  statusMessage!: string;

  @Column({ type: "varchar", default: "none" })
  recordingSource!: MeetingRecordingSource;

  /** Path under `config.dataDir`, never an absolute path — see
   * `services/meetings/storage.ts`. Empty when there is no audio. */
  @Column({ type: "varchar", default: "" })
  recordingPath!: string;

  @Column({ type: "varchar", default: "" })
  recordingMime!: string;

  @Column({ type: "bigint", default: 0 })
  recordingBytes!: number;

  @Column({ type: "int", default: 0 })
  durationMs!: number;

  @Column({ type: "varchar", default: "none" })
  transcriptState!: MeetingTranscriptState;

  @Column({ type: "varchar", default: "" })
  transcriptError!: string;

  /** The whole transcript flattened, for search and for prompting. Segments
   * with timings live in {@link MeetingTranscriptSegment}. */
  @Column({ type: "text", default: "" })
  transcriptText!: string;

  @Column({ type: "text", default: "" })
  summaryText!: string;

  /** `[{title, owner, dueAt, activityId}]` — what the follow-up pass filed. */
  @Column({ type: "text", default: "[]" })
  actionItemsJson!: string;

  /** The employee that records and then writes up this meeting. */
  @Column({ type: "varchar", nullable: true })
  notetakerEmployeeId!: string | null;

  /** Set once the attendee→Contact pass has run to completion. */
  @Column({ type: dateTimeColumnType, nullable: true })
  linkedAt!: Date | null;

  /** Set once the AI write-up has run, successfully or not. */
  @Column({ type: dateTimeColumnType, nullable: true })
  summarisedAt!: Date | null;

  @Column({ type: "varchar", nullable: true })
  customerId!: string | null;

  @Column({ type: "varchar", nullable: true })
  dealId!: string | null;

  @Column({ type: "varchar", nullable: true })
  createdByUserId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
