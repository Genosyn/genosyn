import { IsNull } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Contact } from "../../db/entities/Contact.js";
import { Deal } from "../../db/entities/Deal.js";
import { Meeting } from "../../db/entities/Meeting.js";
import { MeetingParticipant } from "../../db/entities/MeetingParticipant.js";
import { Customer } from "../../db/entities/Customer.js";
import { recordMeetingActivity } from "../revenue/activities.js";
import { findContactsByEmails } from "../revenue/contacts.js";
import { linkMeetingCustomer, moveMeetingTimelineRow } from "./customerLink.js";
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
 *    act. The meeting's one Customer, an account rather than a person, is
 *    `customerLink.ts`'s to find or create, and it gets its own timeline row
 *    when no Contact's row reaches it.
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

const NOTHING_LINKED: MeetingLinkResult = {
  matched: 0,
  activities: 0,
  customerId: null,
  dealId: null,
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
 * Deal is an ordinary and correct outcome. A meeting with a customer only takes
 * that customer's Deal, or one on no account: a champion from another account
 * being in the room doesn't make it their Deal's meeting.
 */
async function resolveDeal(
  companyId: string,
  contactIds: string[],
  customerIds: string[],
  meetingCustomerId: string | null,
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

  if (meetingCustomerId) {
    qb.andWhere("(deal.customerId = :meetingCustomerId OR deal.customerId IS NULL)", {
      meetingCustomerId,
    });
  }

  return qb
    .orderBy("CASE WHEN deal.status = 'open' THEN 0 ELSE 1 END", "ASC")
    .addOrderBy("deal.updatedAt", "DESC")
    .getOne();
}

/**
 * Resolve a meeting's participants to Contacts and its Customer, and put the
 * call on their timelines.
 *
 * Safe to call more than once, and meant to be: it runs when a transcript
 * lands, again after the AI write-up (so the row carries the summary), and
 * again on demand.
 */
export async function linkMeeting(companyId: string, meetingId: string): Promise<MeetingLinkResult> {
  const meeting = await AppDataSource.getRepository(Meeting).findOneBy({ id: meetingId, companyId });
  if (!meeting) return NOTHING_LINKED;

  const participants = await listParticipants(companyId, meetingId);
  const addresses = participants.map((row) => row.email);

  // The one query that decides who the people are. Anyone not in here is a
  // stranger, and stays one: a stranger's account may be created below, but
  // never a Contact for them — see rule 1.
  const byEmail = await findContactsByEmails(companyId, addresses);

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

  const { customerId } = await linkMeetingCustomer(companyId, meetingId);
  if (contacts.length === 0 && !customerId) {
    // With nobody to go on there is no Deal either, whatever an earlier
    // customer this meeting had pointed at.
    await AppDataSource.getRepository(Meeting).update(
      { id: meetingId },
      { linkedAt: new Date(), dealId: null },
    );
    return NOTHING_LINKED;
  }

  const customerIds = customerId
    ? [customerId]
    : [...new Set(contacts.map((c) => c.customerId).filter((id): id is string => !!id))];
  // A Member who removed the customer said this meeting is on no account.
  const deal =
    meeting.customerChosen && !customerId
      ? null
      : await resolveDeal(
          companyId,
          contacts.map((c) => c.id),
          customerIds,
          customerId,
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
  const activityRepo = AppDataSource.getRepository(Activity);
  const existingRows = await activityRepo.find({ where: { companyId, meetingId: meeting.id } });

  let activities = 0;
  for (const contact of contacts) {
    const dealId = deal && deal.primaryContactId === contact.id ? deal.id : null;
    // One row per Contact however its Deal changes, carrying the summary once
    // there is one. Keying on the Deal would write the call on their timeline
    // again each time the meeting's customer moved.
    const existing = existingRows.find((row) => row.contactId === contact.id);
    if (existing) {
      const body = bodyText || existing.bodyText;
      if (existing.dealId !== dealId || existing.bodyText !== body) {
        await activityRepo.update({ id: existing.id }, { dealId, bodyText: body });
      }
      continue;
    }
    activities += 1;
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

  // The account's own row, only while nobody's row above reaches its timeline:
  // an account Genosyn just created from the attendees has no Contacts yet, and
  // once it does the call must not read twice.
  const reachedByOthers =
    existingRows.some((row) => row.contactId && row.customerId === customerId) ||
    contacts.some((c) => c.customerId === customerId) ||
    deal?.customerId === customerId;
  const hadAccountRow = existingRows.some((row) => !row.contactId && !row.dealId);
  if (customerId && reachedByOthers) {
    await activityRepo.delete({ companyId, meetingId, contactId: IsNull(), dealId: IsNull() });
  } else if (customerId) {
    await recordMeetingActivity(
      companyId,
      {
        kind: "meeting",
        subject,
        bodyText,
        occurredAt,
        customerId,
        meetingId: meeting.id,
        meta,
      },
      { employeeId: meeting.notetakerEmployeeId },
    );
    if (!hadAccountRow) activities += 1;
  }

  await AppDataSource.getRepository(Meeting).update(
    { id: meetingId },
    {
      linkedAt: new Date(),
      dealId: deal?.id ?? null,
    },
  );

  return {
    matched: contacts.length,
    activities,
    customerId,
    dealId: deal?.id ?? null,
  };
}

export class MeetingCustomerError extends Error {}

/**
 * A Member's choice of customer for this meeting, or of none. It is final: the
 * automatic passes leave the meeting alone from here on. Answers null when the
 * company has no such meeting, and throws {@link MeetingCustomerError} for a
 * customer it doesn't have.
 */
export async function setMeetingCustomer(
  companyId: string,
  meetingId: string,
  customerId: string | null,
): Promise<Meeting | null> {
  const repo = AppDataSource.getRepository(Meeting);
  const meeting = await repo.findOneBy({ id: meetingId, companyId });
  if (!meeting) return null;
  if (
    customerId &&
    !(await AppDataSource.getRepository(Customer).findOneBy({ id: customerId, companyId }))
  ) {
    throw new MeetingCustomerError("Customer not found.");
  }

  // A partial save rewrites only these columns, and still tells open pages.
  const moved = meeting.customerId !== customerId;
  await repo.save({
    id: meeting.id,
    customerId,
    customerChosen: true,
    // The old customer's Deal isn't this one's. The link pass finds its own.
    ...(moved ? { dealId: null } : {}),
  });
  if (moved) {
    await moveMeetingTimelineRow(companyId, meetingId, customerId);
    // A meeting with something on a timeline belongs on its new customer's too.
    if (meeting.transcriptText.trim()) await linkMeetingSafely(companyId, meetingId);
  }
  return repo.findOneBy({ id: meetingId, companyId });
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
