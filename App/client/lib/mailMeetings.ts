import { api } from "./api";
import {
  formatMeetingRange,
  isMeetingTimeZone,
  MAX_MEETING_MINUTES,
  MIN_MEETING_MINUTES,
  parseLocalDateTime,
  timeZoneCity,
  timeZoneShortName,
  utcToZonedLocal,
  zonedLocalToUtc,
} from "../../shared/meetingTime";

/**
 * Meetings scheduled from an email: the scheduler's types, its REST client,
 * and the arithmetic its form does.
 *
 * A meeting is held as the wall time people agreed plus the zone they agreed
 * it in (`shared/meetingTime.ts` says why); everything here converts through
 * that pair, so "3 PM Berlin" stays 3 PM in Berlin when the Member reading it
 * sits in New York.
 */

/** A calendar the Member can put an event on, and send invitations from. */
export type SchedulingCalendar = {
  /** `calendar:<id>` for a Meetings calendar, `mailbox` for the mailbox's own Google calendar. */
  id: string;
  label: string;
  address: string;
  /** The calendar's own zone; "" when Google has not said. */
  timeZone: string;
  isDefault: boolean;
};

export type MeetingAttendee = { email: string; name: string };

export type MeetingTimeOption = {
  /** `YYYY-MM-DDTHH:mm` wall time in `timeZone`. */
  start: string;
  timeZone: string;
  /** The words in the thread the time came from, verified verbatim by the server. */
  evidence: string | null;
};

export type MeetingProposal = {
  title: string;
  attendees: MeetingAttendee[];
  /** Null when the thread never settled on a time. */
  start: string | null;
  timeZone: string;
  durationMinutes: number;
  description: string;
  evidence: string | null;
  alternatives: MeetingTimeOption[];
  /** Whether the time was agreed, only proposed, or never mentioned. */
  confidence: "agreed" | "proposed" | "none";
};

export type MeetingProposalResult = {
  proposal: MeetingProposal;
  /** `ai` when an AI Employee read the thread; `basic` when only the headers were used. */
  source: "ai" | "basic";
  employee: { id: string; name: string } | null;
  note: string | null;
};

export type ScheduleMeetingInput = {
  calendarId: string;
  title: string;
  description?: string;
  start: string;
  timeZone: string;
  durationMinutes: number;
  attendees: MeetingAttendee[];
  addMeet: boolean;
  sendInvites: boolean;
  threadId?: string;
  analysisAction?: { analysisId: string; actionId: string };
};

export type ScheduledMeeting = {
  eventId: string;
  calendarId: string;
  htmlLink: string;
  meetLink: string | null;
  title: string;
  /** ISO instants. */
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  invitesSent: boolean;
};

export type BusyInterval = { start: string; end: string };

const base = (companyId: string) => `/api/companies/${companyId}/mail`;

export const meetingApi = {
  calendars: (cid: string, aid: string) =>
    api.get<{ calendars: SchedulingCalendar[]; setupHint: string | null }>(
      `${base(cid)}/accounts/${aid}/scheduling-calendars`,
    ),
  /** An AI Employee reads the thread and proposes who, when and what. */
  proposal: (cid: string, tid: string, timeZone: string) =>
    api.post<MeetingProposalResult>(`${base(cid)}/threads/${tid}/meeting-proposal`, { timeZone }),
  availability: (
    cid: string,
    aid: string,
    input: { calendarId: string; start: string; end: string },
  ) =>
    api.post<{ busy: BusyInterval[] }>(`${base(cid)}/accounts/${aid}/meetings/availability`, input),
  /** Creates the event, with a Meet link when asked, and has Google send the invitations. */
  schedule: (cid: string, aid: string, input: ScheduleMeetingInput) =>
    api.post<{ meeting: ScheduledMeeting }>(`${base(cid)}/accounts/${aid}/meetings`, input),
};

/** The zone this browser is in, or UTC when it will not say. */
export function viewerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isMeetingTimeZone(zone)) return zone;
  } catch {
    // Fall through.
  }
  return "UTC";
}

/** `{ date: "2026-10-28", time: "15:00" }` for the form's two inputs. */
export function splitLocal(local: string | null): { date: string; time: string } {
  if (!local || !parseLocalDateTime(local)) return { date: "", time: "" };
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/** The two inputs back into a wall time, or null while either is incomplete. */
export function joinLocal(date: string, time: string): string | null {
  const local = `${date}T${time}`;
  return parseLocalDateTime(local) ? local : null;
}

/**
 * Where an empty scheduler starts: the next half hour at least an hour out,
 * inside a 9-to-5 weekday in the meeting's zone — otherwise 10 AM on the next
 * weekday. A suggestion to change, never a time anyone agreed.
 */
export function suggestedStart(now: Date, timeZone: string): string {
  const zone = isMeetingTimeZone(timeZone) ? timeZone : "UTC";
  const earliest = new Date(now.getTime() + 60 * 60_000);
  const local = utcToZonedLocal(earliest, zone);
  const parts = parseLocalDateTime(local);
  if (!parts) return local;
  let minutes = parts.hour * 60 + parts.minute;
  minutes = Math.ceil(minutes / 30) * 30;
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = day.getUTCDay();
  const workday = weekday >= 1 && weekday <= 5;
  if (workday && minutes >= 9 * 60 && minutes <= 16 * 60 + 30) {
    return `${local.slice(0, 10)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }
  if (workday && minutes < 9 * 60) return `${local.slice(0, 10)}T10:00`;
  // After hours or a weekend: 10 AM on the next weekday.
  const next = new Date(day);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T10:00`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The instants a wall time and duration name, or null while the form is incomplete. */
export function meetingInstants(
  start: string | null,
  durationMinutes: number,
  timeZone: string,
): { start: Date; end: Date } | null {
  if (!start) return null;
  const from = zonedLocalToUtc(start, timeZone);
  if (!from) return null;
  return { start: from, end: new Date(from.getTime() + durationMinutes * 60_000) };
}

export function isMeetingDuration(minutes: number): boolean {
  return (
    Number.isInteger(minutes) && minutes >= MIN_MEETING_MINUTES && minutes <= MAX_MEETING_MINUTES
  );
}

/** "30 min", "1 hr", "1 hr 30 min". */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** "Berlin (CET)" — a zone as the picker shows it. */
export function timeZoneOptionLabel(timeZone: string, at: Date, locale?: string): string {
  const short = timeZoneShortName(timeZone, at, locale);
  const city = timeZoneCity(timeZone);
  return short && short !== timeZone && short !== city ? `${city} (${short})` : city;
}

/**
 * "9:00 – 9:30 AM EDT for you" — the same slot in the reader's own zone, or
 * null when the meeting is already in it.
 */
export function viewerSlot(
  instants: { start: Date; end: Date },
  meetingZone: string,
  viewerZone: string,
  locale?: string,
): string | null {
  if (!isMeetingTimeZone(viewerZone) || viewerZone === meetingZone) return null;
  const same =
    utcToZonedLocal(instants.start, viewerZone) === utcToZonedLocal(instants.start, meetingZone) &&
    timeZoneShortName(viewerZone, instants.start, locale) ===
      timeZoneShortName(meetingZone, instants.start, locale);
  if (same) return null;
  return formatMeetingRange(instants.start, instants.end, viewerZone, locale);
}

/** Whether any busy interval overlaps the slot. */
export function overlapsBusy(busy: BusyInterval[], slot: { start: Date; end: Date }): boolean {
  return busy.some((interval) => {
    const from = Date.parse(interval.start);
    const to = Date.parse(interval.end);
    return from < slot.end.getTime() && to > slot.start.getTime();
  });
}

/**
 * What the reply says once the invitation is out — the slot in the meeting's
 * zone (and the recipient-facing link), so the email and the invite agree.
 */
export function inviteConfirmationText(
  meeting: Pick<ScheduledMeeting, "start" | "end" | "timeZone" | "meetLink" | "invitesSent">,
  locale?: string,
): string {
  const when = formatMeetingRange(
    new Date(meeting.start),
    new Date(meeting.end),
    meeting.timeZone,
    locale,
  );
  const lines = [
    meeting.invitesSent ? `I've sent a calendar invite for ${when}.` : `Let's meet ${when}.`,
  ];
  if (meeting.meetLink) lines.push(`Google Meet: ${meeting.meetLink}`);
  return lines.join("\n");
}

/**
 * A proposal from a button the AI analysis attached to the email, on top of
 * the scheduler's own defaults. Only fields the server verified arrive here.
 */
export function proposalFromAnalysis(
  action: {
    title?: string;
    start?: string;
    timeZone?: string;
    durationMinutes?: number;
    attendees?: string[];
  },
  fallback: MeetingProposal,
): MeetingProposal {
  const timeZone =
    action.timeZone && isMeetingTimeZone(action.timeZone) ? action.timeZone : fallback.timeZone;
  const start = action.start && parseLocalDateTime(action.start) ? action.start : fallback.start;
  const named = new Map(
    fallback.attendees.map((person) => [person.email.toLowerCase(), person.name]),
  );
  return {
    ...fallback,
    title: action.title?.trim() || fallback.title,
    start,
    timeZone,
    durationMinutes:
      action.durationMinutes && isMeetingDuration(action.durationMinutes)
        ? action.durationMinutes
        : fallback.durationMinutes,
    attendees:
      action.attendees && action.attendees.length > 0
        ? action.attendees.map((email) => ({ email, name: named.get(email.toLowerCase()) ?? "" }))
        : fallback.attendees,
    confidence: start
      ? fallback.confidence === "none"
        ? "proposed"
        : fallback.confidence
      : "none",
  };
}
