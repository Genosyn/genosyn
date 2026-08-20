import { In, LessThanOrEqual, MoreThan, MoreThanOrEqual, type FindOptionsWhere } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { Meeting, type MeetingStatus } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { MeetingTranscriptSegment } from "../../db/entities/MeetingTranscriptSegment.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { companyDomains, isInternalAddress } from "./domains.js";
import type { StoredAttendee } from "./calendarSync.js";

/**
 * Meetings: the rows a human actually opens, and the policy that decides which
 * calendar events become one.
 *
 * A `Meeting` is created *ahead* of the call, not after it, because that is
 * what makes "the notetaker is armed for your 3pm" something the UI can show
 * and something a human can turn off before it happens. A meeting nobody
 * records simply stays `scheduled` and ages out with its event.
 */

/** How far ahead meetings are materialised. Beyond this the agenda is read
 * straight off `calendar_events`, which is cheaper and always current. */
const ARM_HORIZON_MS = 24 * 60 * 60 * 1000;
/** A brisk sync can still first see an invite just after it began. */
const ARM_CATCH_UP_MS = 10 * 60 * 1000;

export function parseAttendees(json: string): StoredAttendee[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredAttendee[]) : [];
  } catch {
    return [];
  }
}

/**
 * Should the notetaker arm itself for this event?
 *
 * Every clause here is a refusal, and the order matters less than the fact
 * that the default at every step is "no":
 *
 *  - the calendar has to be opted in (`autoRecord !== "off"`) **and** name an
 *    employee to own the write-up, because a recording nobody reads is just a
 *    surveillance artefact;
 *  - the event has to be live (`confirmed`) and have somewhere to join;
 *  - an all-day event is never a call, whatever link is in its description;
 *  - and for `external`, we must actually *know* which domains are ours. With
 *    no known domains every attendee reads as external and the recorder would
 *    arm for the entire calendar, so it refuses instead. That is the one case
 *    where returning `false` on missing information is doing real work.
 */
export function shouldAutoRecord(args: {
  account: Pick<CalendarAccount, "autoRecord" | "notetakerEmployeeId">;
  event: Pick<
    CalendarEvent,
    | "status"
    | "allDay"
    | "conferenceProvider"
    | "conferenceUrl"
    | "attendeesJson"
    | "organizerEmail"
  >;
  domains: Set<string>;
}): boolean {
  const { account, event, domains } = args;
  if (account.autoRecord === "off") return false;
  if (!account.notetakerEmployeeId) return false;
  if (event.status !== "confirmed") return false;
  if (event.allDay) return false;
  // The built-in recorder intentionally supports Google Meet only. Do not arm
  // a Zoom/Teams/Webex row that can do nothing except fail at due time.
  if (event.conferenceProvider !== "meet" || !event.conferenceUrl) return false;
  if (account.autoRecord === "all") return true;

  // `external` from here down.
  if (domains.size === 0) return false;
  const addresses = [
    ...parseAttendees(event.attendeesJson).map((a) => a.email),
    event.organizerEmail,
  ].filter(Boolean);
  return addresses.some((email) => !isInternalAddress(email, domains));
}

/**
 * Materialise meetings for every event this calendar is about to reach.
 *
 * Idempotent on `calendarEventId` (unique), so running it every heartbeat is
 * free. It only ever *creates*: a meeting a human already cancelled must not
 * be resurrected by the next pass, which is what `skipped` is for.
 */
export async function armMeetingsForAccount(
  account: CalendarAccount,
  now = new Date(),
): Promise<number> {
  if (account.autoRecord === "off" || !account.notetakerEmployeeId) return 0;

  const events = await AppDataSource.getRepository(CalendarEvent).find({
    where: {
      accountId: account.id,
      status: "confirmed",
      startAt: MoreThanOrEqual(new Date(now.getTime() - ARM_CATCH_UP_MS)) as unknown as Date,
      endAt: MoreThan(now) as unknown as Date,
    },
    order: { startAt: "ASC" },
    take: 200,
  });

  const horizon = new Date(now.getTime() + ARM_HORIZON_MS);
  const domains = await companyDomains(account.companyId);
  const repo = AppDataSource.getRepository(Meeting);
  let armed = 0;

  for (const event of events) {
    if (event.startAt > horizon) break;
    if (!shouldAutoRecord({ account, event, domains })) continue;
    if (await repo.findOneBy({ calendarEventId: event.id })) continue;

    const meeting = await repo.save(
      repo.create({
        companyId: account.companyId,
        calendarEventId: event.id,
        accountId: account.id,
        title: event.summary || "(no title)",
        scheduledStartAt: event.startAt,
        scheduledEndAt: event.endAt,
        conferenceProvider: event.conferenceProvider,
        conferenceUrl: event.conferenceUrl,
        status: "scheduled",
        notetakerEmployeeId: account.notetakerEmployeeId,
      }),
    );
    await syncParticipantsFromEvent(meeting, event, domains);
    armed += 1;
  }
  return armed;
}

/**
 * Copy an event's attendees onto the meeting.
 *
 * Contacts are **not** resolved here — that is `revenueLink.ts`'s job and it
 * runs when there is something worth putting on a timeline. This only records
 * who was invited, and freezes `isInternal` at the value the auto-record
 * policy actually keyed on.
 */
export async function syncParticipantsFromEvent(
  meeting: Meeting,
  event: CalendarEvent,
  domains: Set<string>,
): Promise<void> {
  const repo = AppDataSource.getRepository(MeetingParticipant);
  const attendees = parseAttendees(event.attendeesJson);
  const organizer = normalizeEmail(event.organizerEmail);

  const byEmail = new Map<
    string,
    { displayName: string; responseStatus: string; organizer: boolean }
  >();
  for (const attendee of attendees) {
    byEmail.set(attendee.email, {
      displayName: attendee.displayName,
      responseStatus: attendee.responseStatus,
      organizer: attendee.organizer,
    });
  }
  // An organizer who did not invite themselves is still in the room.
  if (organizer && !byEmail.has(organizer)) {
    byEmail.set(organizer, {
      displayName: event.organizerName,
      responseStatus: "accepted",
      organizer: true,
    });
  }

  for (const [email, detail] of byEmail) {
    if (await repo.findOneBy({ meetingId: meeting.id, email })) continue;
    await repo.save(
      repo.create({
        companyId: meeting.companyId,
        meetingId: meeting.id,
        email,
        displayName: detail.displayName,
        isOrganizer: detail.organizer || email === organizer,
        isInternal: isInternalAddress(email, domains),
        responseStatus: detail.responseStatus,
      }),
    );
  }
}

// ───────────────────────────── reads ─────────────────────────────

export type MeetingListFilter = {
  status?: MeetingStatus;
  customerId?: string;
  contactId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
};

export async function listMeetings(
  companyId: string,
  filter: MeetingListFilter = {},
): Promise<Meeting[]> {
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));

  // A contact filter is a join through participants, which is exactly the
  // query `meeting_participants` exists to make cheap.
  let meetingIds: string[] | null = null;
  if (filter.contactId) {
    const rows = await AppDataSource.getRepository(MeetingParticipant).find({
      where: { companyId, contactId: filter.contactId },
      select: { meetingId: true },
    });
    meetingIds = rows.map((row) => row.meetingId);
    if (meetingIds.length === 0) return [];
  }

  const where: FindOptionsWhere<Meeting> = { companyId };
  if (filter.status) where.status = filter.status;
  if (filter.customerId) where.customerId = filter.customerId;
  if (meetingIds) where.id = In(meetingIds);
  if (filter.from && filter.to) {
    where.scheduledStartAt = MoreThanOrEqual(filter.from) as unknown as Date;
  } else if (filter.from) {
    where.scheduledStartAt = MoreThanOrEqual(filter.from) as unknown as Date;
  } else if (filter.to) {
    where.scheduledStartAt = LessThanOrEqual(filter.to) as unknown as Date;
  }

  const rows = await AppDataSource.getRepository(Meeting).find({
    where,
    order: { scheduledStartAt: "DESC", createdAt: "DESC" },
    take: limit,
  });
  // `from` + `to` together needs both bounds; TypeORM's object form holds one
  // operator per column, so the upper bound is applied here rather than
  // reaching for a query builder for one clause.
  if (filter.from && filter.to) {
    const to = filter.to;
    return rows.filter((row) => !row.scheduledStartAt || row.scheduledStartAt <= to);
  }
  return rows;
}

export async function getMeeting(companyId: string, id: string): Promise<Meeting | null> {
  return AppDataSource.getRepository(Meeting).findOneBy({ id, companyId });
}

export async function listParticipants(
  companyId: string,
  meetingId: string,
): Promise<MeetingParticipant[]> {
  return AppDataSource.getRepository(MeetingParticipant).find({
    where: { companyId, meetingId },
    order: { isOrganizer: "DESC", email: "ASC" },
  });
}

export async function listTranscriptSegments(
  companyId: string,
  meetingId: string,
): Promise<MeetingTranscriptSegment[]> {
  return AppDataSource.getRepository(MeetingTranscriptSegment).find({
    where: { companyId, meetingId },
    order: { sortOrder: "ASC" },
  });
}

// ───────────────────────────── writes ─────────────────────────────

/**
 * Create a meeting that was never on a calendar — a call somebody just had.
 *
 * `attendeeEmails` matters more than it looks: without participants there is
 * nothing for the linker to match, so an ad-hoc meeting with no attendees can
 * never reach a customer's timeline no matter how good its transcript is. It
 * is the whole reason this path can stand alone on an install with no calendar
 * connected.
 */
export async function createAdHocMeeting(args: {
  companyId: string;
  title: string;
  scheduledStartAt: Date | null;
  conferenceUrl: string;
  notetakerEmployeeId: string | null;
  createdByUserId: string | null;
  attendeeEmails?: string[];
}): Promise<Meeting> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.save(
    repo.create({
      companyId: args.companyId,
      title: args.title,
      scheduledStartAt: args.scheduledStartAt,
      conferenceUrl: args.conferenceUrl,
      notetakerEmployeeId: args.notetakerEmployeeId,
      createdByUserId: args.createdByUserId,
      status: "scheduled",
    }),
  );
  if (args.attendeeEmails && args.attendeeEmails.length > 0) {
    await addParticipants(meeting, args.attendeeEmails);
  }
  return meeting;
}

/**
 * Put people on a meeting by address.
 *
 * De-duplicated against what is already there, so calling it twice with an
 * overlapping list does not violate the `(meetingId, email)` unique index.
 * Contacts are not resolved here — that is `revenueLink.ts`'s job, and it runs
 * when there is something worth putting on a timeline.
 */
export async function addParticipants(meeting: Meeting, emails: string[]): Promise<number> {
  const repo = AppDataSource.getRepository(MeetingParticipant);
  const domains = await companyDomains(meeting.companyId);
  let added = 0;
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (await repo.findOneBy({ meetingId: meeting.id, email })) continue;
    await repo.save(
      repo.create({
        companyId: meeting.companyId,
        meetingId: meeting.id,
        email,
        displayName: "",
        isOrganizer: false,
        isInternal: isInternalAddress(email, domains),
        responseStatus: "",
      }),
    );
    added += 1;
  }
  return added;
}

export async function setMeetingStatus(
  companyId: string,
  id: string,
  status: MeetingStatus,
  statusMessage = "",
): Promise<Meeting | null> {
  const repo = AppDataSource.getRepository(Meeting);
  const row = await repo.findOneBy({ id, companyId });
  if (!row) return null;
  row.status = status;
  row.statusMessage = statusMessage;
  if (status === "recording" && !row.startedAt) row.startedAt = new Date();
  if ((status === "ready" || status === "failed") && !row.endedAt) row.endedAt = new Date();
  return repo.save(row);
}

/**
 * Replace a meeting's transcript.
 *
 * Segments are rewritten wholesale rather than merged: a re-transcription is a
 * new reading of the same audio, and interleaving it with the old one would
 * produce a transcript that never existed. The flattened copy on the meeting
 * is rebuilt in the same call so the two can never disagree.
 */
export async function replaceTranscript(args: {
  companyId: string;
  meetingId: string;
  segments: Array<{ startMs: number; endMs: number; speaker: string; text: string }>;
}): Promise<number> {
  const segmentRepo = AppDataSource.getRepository(MeetingTranscriptSegment);
  await segmentRepo.delete({ meetingId: args.meetingId });

  const rows = args.segments
    .map((segment, index) =>
      segmentRepo.create({
        companyId: args.companyId,
        meetingId: args.meetingId,
        sortOrder: index,
        startMs: Math.max(0, Math.trunc(segment.startMs)),
        endMs: Math.max(0, Math.trunc(segment.endMs)),
        speaker: segment.speaker.slice(0, 200),
        text: segment.text,
      }),
    )
    .filter((row) => row.text.trim() !== "");

  if (rows.length > 0) await segmentRepo.save(rows, { chunk: 200 });

  const flat = rows
    .map((row) => (row.speaker ? `${row.speaker}: ${row.text}` : row.text))
    .join("\n");
  await AppDataSource.getRepository(Meeting).update(
    { id: args.meetingId },
    { transcriptText: flat, transcriptState: "ready", transcriptError: "" },
  );
  return rows.length;
}
