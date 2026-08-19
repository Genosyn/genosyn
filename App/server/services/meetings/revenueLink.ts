import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { recordMeetingActivity } from "../revenue/activities.js";
import { findContactsByEmails } from "../revenue/contacts.js";
import { listParticipants } from "./store.js";

/**
 * Meeting → Contact auto-linking: the reason a customer's timeline knows about
 * the call.
 *
 * This is `revenue/mailLink.ts` applied to a different input, and it inherits
 * that module's rules deliberately rather than by accident:
 *
 * 1. **We link to Contacts that already exist. We never create one.** A
 *    calendar is mostly colleagues, recruiters, vendors, interviews and
 *    one-off strangers. Upserting a Contact per attendee would turn a curated
 *    list of the people you sell to into thousands of junk rows, and every
 *    number downstream — contact counts, stale-contact nudges, sequence
 *    targeting — becomes noise with it. Creating a Contact stays an explicit
 *    act.
 *
 * 2. **Idempotency is keyed on the (meeting, subject) pair.** One call
 *    attended by three known Contacts is three timeline rows, and re-running
 *    the linker writes none of them twice. Re-running is expected: a Contact
 *    created *after* a call should be able to pick it up, which is exactly
 *    what mail linking cannot do and what `linkMeeting` deliberately can.
 *
 * 3. **Never break the meeting.** Everything here is enrichment. A CRM failure
 *    must not stop a transcript being stored, so `linkMeetingSafely` swallows
 *    and logs rather than throwing into a sync pass.
 */

/** Transcript excerpt put on the timeline row. The full text lives on the
 * Meeting; `ACTIVITY_BODY_CAP` would truncate a real transcript anyway, and a
 * timeline is for scanning. */
const TIMELINE_EXCERPT = 1_200;

export type MeetingLinkResult = {
  /** Participants that resolved to a known Contact. */
  matched: number;
  /** Activity rows actually written (a re-run writes none). */
  activities: number;
  customerId: string | null;
  dealId: string | null;
};

/**
 * What the timeline row says happened.
 *
 * The AI summary when there is one, because that is what a human wants to read
 * three weeks later; the transcript's opening otherwise; and a bare note when
 * there is neither, so a call with no recording still marks the timeline.
 */
function timelineBody(meeting: Meeting): string {
  const summary = meeting.summaryText.trim();
  if (summary) return summary.slice(0, TIMELINE_EXCERPT);
  const transcript = meeting.transcriptText.trim();
  if (transcript) return `${transcript.slice(0, TIMELINE_EXCERPT)}…`;
  return "";
}

/**
 * Which Deal does this call belong to?
 *
 * Mirrors the widening `documentCapture.ts` already uses: a Deal where one of
 * these Contacts is the champion, **or** any Deal on their Account. Open deals
 * win over closed ones, then most recently touched, because a call is about
 * the live thing far more often than the archived one.
 *
 * Returns null rather than guessing when nothing matches — a meeting on no
 * Deal is an ordinary and correct outcome.
 */
async function resolveDeal(
  companyId: string,
  contactIds: string[],
  customerIds: string[],
): Promise<Deal | null> {
  if (contactIds.length === 0 && customerIds.length === 0) return null;
  const qb = AppDataSource.getRepository(Deal)
    .createQueryBuilder("deal")
    .where("deal.companyId = :companyId", { companyId });

  if (contactIds.length > 0 && customerIds.length > 0) {
    qb.andWhere(
      "(deal.primaryContactId IN (:...contactIds) OR deal.customerId IN (:...customerIds))",
      { contactIds, customerIds },
    );
  } else if (contactIds.length > 0) {
    qb.andWhere("deal.primaryContactId IN (:...contactIds)", { contactIds });
  } else {
    qb.andWhere("deal.customerId IN (:...customerIds)", { customerIds });
  }

  return qb
    .orderBy("CASE WHEN deal.status = 'open' THEN 0 ELSE 1 END", "ASC")
    .addOrderBy("deal.updatedAt", "DESC")
    .getOne();
}

/**
 * Resolve a meeting's participants to Contacts and put the call on their
 * timelines.
 *
 * Safe to call more than once, and meant to be: it runs when a transcript
 * lands, again after the AI write-up (so the row carries the summary), and
 * again on demand.
 */
export async function linkMeeting(companyId: string, meetingId: string): Promise<MeetingLinkResult> {
  const meeting = await AppDataSource.getRepository(Meeting).findOneBy({ id: meetingId, companyId });
  if (!meeting) return { matched: 0, activities: 0, customerId: null, dealId: null };

  const participants = await listParticipants(companyId, meetingId);
  const addresses = participants.map((row) => row.email);
  if (addresses.length === 0) {
    return { matched: 0, activities: 0, customerId: null, dealId: null };
  }

  // The one query that decides everything. Anything not in here is a stranger,
  // and a stranger stays a stranger — see rule 1.
  const byEmail = await findContactsByEmails(companyId, addresses);
  if (byEmail.size === 0) {
    await AppDataSource.getRepository(Meeting).update({ id: meetingId }, { linkedAt: new Date() });
    return { matched: 0, activities: 0, customerId: null, dealId: null };
  }

  // Remember the resolution on the participant row so "who was in the room"
  // stays answerable without redoing the match.
  const participantRepo = AppDataSource.getRepository(MeetingParticipant);
  const contacts: Contact[] = [];
  const seen = new Set<string>();
  for (const participant of participants) {
    const contact = byEmail.get(participant.email);
    if (!contact) continue;
    if (participant.contactId !== contact.id) {
      await participantRepo.update({ id: participant.id }, { contactId: contact.id });
    }
    if (seen.has(contact.id)) continue;
    seen.add(contact.id);
    contacts.push(contact);
  }
  if (contacts.length === 0) {
    await AppDataSource.getRepository(Meeting).update({ id: meetingId }, { linkedAt: new Date() });
    return { matched: 0, activities: 0, customerId: null, dealId: null };
  }

  const customerIds = [...new Set(contacts.map((c) => c.customerId).filter((id): id is string => !!id))];
  const deal = await resolveDeal(
    companyId,
    contacts.map((c) => c.id),
    customerIds,
  );

  const occurredAt =
    meeting.startedAt ?? meeting.scheduledStartAt ?? meeting.endedAt ?? meeting.createdAt;
  const subject = meeting.title || "Meeting";
  const bodyText = timelineBody(meeting);
  const meta = {
    meetingId: meeting.id,
    conferenceProvider: meeting.conferenceProvider,
    durationMs: meeting.durationMs,
    hasTranscript: meeting.transcriptState === "ready",
  };

  // What is already on a timeline for this meeting, read once. `recordMeetingActivity`
  // returns the existing row and a fresh row identically, so "how many did we
  // actually write" has to be answered before writing rather than inferred after.
  const alreadyLinked = new Set(
    (
      await AppDataSource.getRepository(Activity).find({
        where: { companyId, meetingId: meeting.id },
        select: { contactId: true, dealId: true },
      })
    ).map((row) => `${row.contactId ?? ""}|${row.dealId ?? ""}`),
  );

  let activities = 0;
  for (const contact of contacts) {
    const dealId = deal && deal.primaryContactId === contact.id ? deal.id : null;
    if (!alreadyLinked.has(`${contact.id}|${dealId ?? ""}`)) activities += 1;
    await recordMeetingActivity(
      companyId,
      {
        kind: "meeting",
        subject,
        bodyText,
        occurredAt,
        contactId: contact.id,
        customerId: contact.customerId,
        dealId,
        meetingId: meeting.id,
        meta,
      },
      { employeeId: meeting.notetakerEmployeeId },
    );
  }

  // The Deal timeline gets its own row when the champion was not in the room —
  // otherwise the row above already carries `dealId` and a second would double it.
  if (deal && !contacts.some((c) => c.id === deal.primaryContactId)) {
    await recordMeetingActivity(
      companyId,
      {
        kind: "meeting",
        subject,
        bodyText,
        occurredAt,
        dealId: deal.id,
        customerId: deal.customerId,
        meetingId: meeting.id,
        meta,
      },
      { employeeId: meeting.notetakerEmployeeId },
    );
  }

  await AppDataSource.getRepository(Meeting).update(
    { id: meetingId },
    {
      linkedAt: new Date(),
      customerId: customerIds[0] ?? null,
      dealId: deal?.id ?? null,
    },
  );

  return {
    matched: contacts.length,
    activities,
    customerId: customerIds[0] ?? null,
    dealId: deal?.id ?? null,
  };
}

/** {@link linkMeeting} with the failure policy attached: log and carry on. */
export async function linkMeetingSafely(
  companyId: string,
  meetingId: string,
): Promise<MeetingLinkResult | null> {
  try {
    return await linkMeeting(companyId, meetingId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[meetings] linking failed for meeting ${meetingId}:`, err);
    return null;
  }
}
