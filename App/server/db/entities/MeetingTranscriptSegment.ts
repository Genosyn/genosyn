import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "typeorm";

/**
 * One utterance in a meeting transcript.
 *
 * Segments are kept as rows, and the same text is also flattened onto
 * `Meeting.transcriptText`. That duplication is deliberate: the flat column is
 * what search and the model prompt want, and the rows are what the page wants
 * — a transcript you can click a timestamp in, attribute to a speaker, and
 * jump around. Rebuilding either from the other on every read would be the
 * expensive half of both.
 *
 * `sortOrder` is authoritative rather than `startMs`. Not every transcription
 * backend returns timings — a pasted transcript has none at all — and a list
 * that silently reorders itself when the timings are zero is worse than one
 * that keeps the order it was given.
 *
 * No `createdAt`: a segment is written once, as part of a batch that
 * `Meeting.transcriptState` already timestamps, and 600 rows per hour-long
 * meeting is not the place to spend a column nobody reads.
 */
@Entity("meeting_transcript_segments")
@Index(["meetingId", "sortOrder"])
@Index(["companyId"])
export class MeetingTranscriptSegment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  meetingId!: string;

  @Column({ type: "int", default: 0 })
  sortOrder!: number;

  /** Offset from the start of the recording. Zero when unknown. */
  @Column({ type: "int", default: 0 })
  startMs!: number;

  @Column({ type: "int", default: 0 })
  endMs!: number;

  /** Whatever the backend called them — matched to a participant later. */
  @Column({ type: "varchar", default: "" })
  speaker!: string;

  @Column({ type: "text", default: "" })
  text!: string;
}
