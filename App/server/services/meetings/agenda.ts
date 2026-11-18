import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarEvent } from "../../db/entities/CalendarEvent.js";
import { Meeting, type MeetingStatus } from "../../db/entities/Meeting.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { findContactsByEmails } from "../revenue/contacts.js";
import type { StoredAttendee } from "./calendarSync.js";
import { serializeCalendarEvent, type CalendarEventDTO } from "./serialize.js";

/**
 * The agenda: calendar events in a window, with what a person needs to act on
 * each one without leaving the page.
 *
 * A bare event says who was invited. The agenda also says which of those
 * people are already Contacts, so a name opens their timeline, and whether
 * Genosyn holds a Meeting for the event, so a row opens its notes, recording
 * and transcript. Both are batch lookups — one query each, however many
 * events the window holds.
 */

/** Most events one agenda read returns. A week rarely comes near it. */
export const AGENDA_EVENT_LIMIT = 500;

export type AgendaAttendee = StoredAttendee & {
  /** The Contact with this address, when there is one. */
  contactId: string | null;
  /** That Contact's name, which Google often leaves out of the invite. */
  contactName: string;
};

export type AgendaEvent = Omit<CalendarEventDTO, "attendees"> & {
  attendees: AgendaAttendee[];
  /** The Meeting Genosyn keeps for this event: notes, recording, transcript. */
  meeting: { id: string; status: MeetingStatus } | null;
};

/**
 * Everyone on the invite, organizer included.
 *
 * Google lists the organizer among the attendees when there are guests, but
 * not always — an invite sent from a shared calendar, or from a delegate, can
 * leave them out. They are the first person anyone writes to about a meeting,
 * so they are added back when missing. An event with nobody else on it is a
 * block on someone's own calendar, and gets no attendee list at all.
 */
export function inviteList(
  attendees: StoredAttendee[],
  organizerEmail: string,
  organizerName: string,
): StoredAttendee[] {
  if (attendees.length === 0) return [];
  const organizer = normalizeEmail(organizerEmail);
  if (!organizer || attendees.some((row) => row.email === organizer)) return attendees;
  return [
    {
      email: organizer,
      displayName: organizerName,
      // Unknown, not invented: Google sent no reply for an address it did not list.
      responseStatus: "",
      organizer: true,
      optional: false,
    },
    ...attendees,
  ];
}

export async function listAgendaEvents(
  companyId: string,
  window: { from: Date; to: Date; accountId?: string },
): Promise<AgendaEvent[]> {
  const qb = AppDataSource.getRepository(CalendarEvent)
    .createQueryBuilder("event")
    .where("event.companyId = :cid", { cid: companyId })
    .andWhere("event.status != :cancelled", { cancelled: "cancelled" })
    .andWhere("event.startAt < :to AND event.endAt > :from", {
      from: window.from,
      to: window.to,
    })
    .orderBy("event.startAt", "ASC")
    .take(AGENDA_EVENT_LIMIT);
  if (window.accountId) {
    qb.andWhere("event.accountId = :accountId", { accountId: window.accountId });
  }
  const rows = await qb.getMany();
  if (rows.length === 0) return [];

  const events = rows.map((row) => {
    const dto = serializeCalendarEvent(row);
    return { ...dto, attendees: inviteList(dto.attendees, dto.organizerEmail, dto.organizerName) };
  });

  const [meetings, contacts] = await Promise.all([
    AppDataSource.getRepository(Meeting).find({
      select: { id: true, status: true, calendarEventId: true },
      where: { companyId, calendarEventId: In(events.map((event) => event.id)) },
    }),
    findContactsByEmails(
      companyId,
      events.flatMap((event) => event.attendees.map((row) => row.email)),
    ),
  ]);
  const meetingByEvent = new Map(
    meetings.map((meeting) => [meeting.calendarEventId, meeting] as const),
  );

  return events.map((event) => {
    const meeting = meetingByEvent.get(event.id);
    return {
      ...event,
      attendees: event.attendees.map((row) => {
        const contact = contacts.get(row.email);
        return { ...row, contactId: contact?.id ?? null, contactName: contact?.name ?? "" };
      }),
      meeting: meeting ? { id: meeting.id, status: meeting.status } : null,
    };
  });
}
