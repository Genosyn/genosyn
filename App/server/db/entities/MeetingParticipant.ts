import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * One person on one meeting, and the Contact they turned out to be.
 *
 * Rows rather than JSON precisely because of `contactId`: this is the join
 * that makes "every meeting with this customer" and "who was in the room" real
 * queries. The email is stored normalised and always kept, even when no
 * Contact matches — a stranger today is frequently a Contact next week, and
 * re-running the link pass then should be able to find them without re-reading
 * the calendar.
 *
 * `isInternal` is decided against the company's own mail domains at link time
 * and frozen here, because it is what the auto-record policy keyed on and a
 * domain added later must not silently rewrite the past.
 */
@Entity("meeting_participants")
@Index(["meetingId"])
@Index(["companyId", "email"])
@Index(["contactId"])
@Index(["meetingId", "email"], { unique: true })
export class MeetingParticipant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar" })
  companyId!: string;

  @Column({ type: "varchar" })
  meetingId!: string;

  /** Lowercased, angle-brackets stripped — `lib/emailAddress.ts`. */
  @Column({ type: "varchar" })
  email!: string;

  @Column({ type: "varchar", default: "" })
  displayName!: string;

  /** The Contact this address resolved to, or null for a stranger. */
  @Column({ type: "varchar", nullable: true })
  contactId!: string | null;

  @Column({ type: "boolean", default: false })
  isOrganizer!: boolean;

  @Column({ type: "boolean", default: false })
  isInternal!: boolean;

  /** Google's RSVP: `accepted` / `declined` / `tentative` / `needsAction`. */
  @Column({ type: "varchar", default: "" })
  responseStatus!: string;

  /** How this person appears in the transcript, when we can tell. */
  @Column({ type: "varchar", default: "" })
  speakerLabel!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
