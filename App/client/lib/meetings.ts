import { api } from "./api";
import type { BadgeTone } from "../components/ui/Badge";

/**
 * Client-side types + fetchers for the Meetings section (M44).
 *
 * Mirrors `client/lib/mail.ts`: one `meetingsApi` object over the shared `api`
 * helper, with dates as ISO strings because that is what the server sends and
 * parsing them here would just push `Date | string` into every component.
 */

export type ConferenceProvider = "meet" | "zoom" | "teams" | "webex" | "other" | "none";

export type CalendarAutoRecord = "off" | "external" | "all";

export type CalendarAccountStatus = "active" | "paused" | "error";

export type CalendarSyncState = "idle" | "queued" | "running" | "succeeded" | "failed";

export type CalendarAccount = {
  id: string;
  connectionId: string;
  calendarId: string;
  address: string;
  displayName: string;
  timeZone: string;
  status: CalendarAccountStatus;
  statusMessage: string;
  syncState: CalendarSyncState;
  lastSyncAt: string | null;
  syncStartedAt: string | null;
  syncFinishedAt: string | null;
  windowDays: number;
  autoRecord: CalendarAutoRecord;
  notetakerEmployeeId: string | null;
  createdAt: string;
};

export type CalendarAttendee = {
  email: string;
  displayName: string;
  /** Google's reply: `accepted`, `declined`, `tentative`, `needsAction`, or "" when unknown. */
  responseStatus: string;
  organizer: boolean;
  optional: boolean;
  /** The Contact with this address, when there is one. */
  contactId: string | null;
  /** That Contact's name — Google often leaves names out of an invite. */
  contactName: string;
};

export type CalendarEvent = {
  id: string;
  accountId: string;
  summary: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  organizerEmail: string;
  organizerName: string;
  attendees: CalendarAttendee[];
  conferenceProvider: ConferenceProvider;
  conferenceUrl: string;
  htmlLink: string;
  recurring: boolean;
  /** The Meeting Genosyn keeps for this event — its notes, recording and transcript. */
  meeting: { id: string; status: MeetingStatus } | null;
};

export type MeetingStatus =
  | "scheduled"
  | "joining"
  | "recording"
  | "processing"
  | "ready"
  | "failed"
  | "skipped";

export type MeetingTranscriptState = "none" | "queued" | "running" | "ready" | "failed";

export type MeetingActionItem = {
  title: string;
  owner: string;
  dueAt: string | null;
  activityId: string | null;
};

export type Meeting = {
  id: string;
  calendarEventId: string | null;
  accountId: string | null;
  title: string;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  conferenceProvider: ConferenceProvider;
  conferenceUrl: string;
  status: MeetingStatus;
  statusMessage: string;
  recordingSource: "notetaker" | "upload" | "transcript" | "none";
  hasRecording: boolean;
  recordingMime: string;
  recordingBytes: number;
  durationMs: number;
  transcriptState: MeetingTranscriptState;
  transcriptError: string;
  summaryText: string;
  actionItems: MeetingActionItem[];
  notetakerEmployeeId: string | null;
  linkedAt: string | null;
  summarisedAt: string | null;
  customerId: string | null;
  /** A Member chose this customer, or chose none, so linking leaves it alone. */
  customerChosen: boolean;
  /** On a list row: its customer, when the reader may open Customers. */
  customer?: MeetingCustomer | null;
  dealId: string | null;
  createdAt: string;
};

/** A meeting's customer: its name and where to go, never a billing detail. */
export type MeetingCustomer = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  accountStatus: "prospect" | "customer" | "former";
  archived: boolean;
};

export type MeetingParticipant = {
  id: string;
  email: string;
  displayName: string;
  contactId: string | null;
  isOrganizer: boolean;
  isInternal: boolean;
  responseStatus: string;
};

export type MeetingTranscriptSegment = {
  id: string;
  sortOrder: number;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
};

export type MeetingDetail = {
  meeting: Meeting;
  customer: MeetingCustomer | null;
  /** It has a customer this reader's Finance access doesn't let them open. */
  customerWithheld: boolean;
  participants: MeetingParticipant[];
  transcript: MeetingTranscriptSegment[];
};

export type CalendarGrant = {
  employeeId: string;
  employeeName: string;
  employeeSlug: string;
  accountId: string;
  accountLabel: string;
  accessLevel: "read" | "record";
};

export type ConnectableCalendar = {
  calendarId: string;
  summary: string;
  primary: boolean;
  timeZone: string;
};

export type CalendarCandidateConnection = {
  id: string;
  accountHint: string;
  status: string;
};

const base = (companyId: string) => `/api/companies/${companyId}/meetings`;

export const meetingsApi = {
  calendars: (companyId: string) =>
    api.get<{ calendars: CalendarAccount[] }>(`${base(companyId)}/calendars`),

  candidates: (companyId: string) =>
    api.get<{ connections: CalendarCandidateConnection[] }>(
      `${base(companyId)}/calendars/candidates`,
    ),

  connectable: (companyId: string, connectionId: string) =>
    api.get<{ calendars: ConnectableCalendar[] }>(
      `${base(companyId)}/calendars/connectable?connectionId=${encodeURIComponent(connectionId)}`,
    ),

  connectCalendar: (companyId: string, body: { connectionId: string; calendarId: string }) =>
    api.post<{ calendar: CalendarAccount }>(`${base(companyId)}/calendars`, body),

  patchCalendar: (
    companyId: string,
    id: string,
    body: Partial<{
      status: "active" | "paused";
      autoRecord: CalendarAutoRecord;
      notetakerEmployeeId: string | null;
      windowDays: number;
    }>,
  ) => api.patch<{ calendar: CalendarAccount }>(`${base(companyId)}/calendars/${id}`, body),

  deleteCalendar: (companyId: string, id: string) =>
    api.del<{ ok: boolean }>(`${base(companyId)}/calendars/${id}`),

  syncCalendar: (companyId: string, id: string) =>
    api.post<{ upserted: number; cancelled: number; pruned: number; armed: number }>(
      `${base(companyId)}/calendars/${id}/sync`,
    ),

  events: (companyId: string, params: { from: string; to: string; accountId?: string }) => {
    const query = new URLSearchParams({ from: params.from, to: params.to });
    if (params.accountId) query.set("accountId", params.accountId);
    return api.get<{ events: CalendarEvent[] }>(`${base(companyId)}/events?${query.toString()}`);
  },

  meetings: (
    companyId: string,
    params: {
      status?: MeetingStatus;
      customerId?: string;
      contactId?: string;
      limit?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.customerId) query.set("customerId", params.customerId);
    if (params.contactId) query.set("contactId", params.contactId);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString();
    return api.get<{ meetings: Meeting[] }>(`${base(companyId)}${suffix ? `?${suffix}` : ""}`);
  },

  meeting: (companyId: string, id: string) => api.get<MeetingDetail>(`${base(companyId)}/${id}`),

  createMeeting: (
    companyId: string,
    body: {
      title: string;
      scheduledStartAt?: string | null;
      conferenceUrl?: string;
      notetakerEmployeeId?: string | null;
      attendeeEmails?: string[];
    },
  ) => api.post<{ meeting: Meeting }>(`${base(companyId)}`, body),

  addAttendees: (companyId: string, id: string, emails: string[]) =>
    api.post<{ added: number; participants: MeetingParticipant[] }>(
      `${base(companyId)}/${id}/attendees`,
      { emails },
    ),

  uploadRecording: (companyId: string, id: string, file: File) =>
    api.uploadFile<{ meeting: Meeting | null }>(`${base(companyId)}/${id}/recording`, file),

  pasteTranscript: (companyId: string, id: string, text: string) =>
    api.post<{ meeting: Meeting | null }>(`${base(companyId)}/${id}/transcript`, { text }),

  process: (companyId: string, id: string) =>
    api.post<{ meeting: Meeting | null }>(`${base(companyId)}/${id}/process`),

  link: (companyId: string, id: string) =>
    api.post<{ result: { matched: number; activities: number; customerId: string | null } }>(
      `${base(companyId)}/${id}/link`,
    ),

  setCustomer: (companyId: string, id: string, customerId: string | null) =>
    api.put<{ meeting: Meeting; customer: MeetingCustomer | null }>(
      `${base(companyId)}/${id}/customer`,
      { customerId },
    ),

  startNotetaker: (companyId: string, id: string) =>
    api.post<{ meeting: Meeting | null }>(`${base(companyId)}/${id}/notetaker`),

  stopNotetaker: (companyId: string, id: string) =>
    api.post<{ meeting: Meeting | null }>(`${base(companyId)}/${id}/notetaker/stop`),

  recordingUrl: (companyId: string, id: string) => `${base(companyId)}/${id}/recording`,

  grants: (companyId: string) =>
    api.get<{ grants: CalendarGrant[] }>(`${base(companyId)}/ai-access`),

  grant: (
    companyId: string,
    body: { employeeId: string; accountId: string; accessLevel: "read" | "record" },
  ) => api.put<{ grants: CalendarGrant[] }>(`${base(companyId)}/ai-access`, body),

  revoke: (companyId: string, body: { employeeId: string; accountId: string }) =>
    api.post<{ grants: CalendarGrant[] }>(`${base(companyId)}/ai-access/revoke`, body),
};

// ───────────────────────────── formatting ─────────────────────────────

export const PROVIDER_LABELS: Record<ConferenceProvider, string> = {
  meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  webex: "Webex",
  other: "Video call",
  none: "No link",
};

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: "Scheduled",
  joining: "Joining",
  recording: "Recording",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
  skipped: "Skipped",
};

/** Tailwind chip classes per status. Every colour carries its dark twin. */
export const MEETING_STATUS_TONES: Record<MeetingStatus, string> = {
  scheduled:
    "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-700/40 dark:text-slate-300 dark:ring-slate-600",
  joining:
    "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30",
  recording:
    "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30",
  processing:
    "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30",
  ready:
    "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30",
  failed:
    "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30",
  skipped:
    "bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-700/40 dark:text-slate-400 dark:ring-slate-600",
};

/**
 * Split a free-text address list into addresses.
 *
 * Accepts commas, semicolons, and newlines because people paste attendee lists
 * out of a calendar invite, an email header, and a spreadsheet, and all three
 * use a different separator.
 */
export function parseEmailList(input: string): string[] {
  return input
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.includes("@"));
}

/** `01:23` / `1:02:03`, for a transcript timestamp. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Local `HH:MM` for an agenda row. */
export function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatDayLabel(date: Date): string {
  const today = new Date();
  const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, tomorrow)) return "Tomorrow";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** `1h 12m` — a recording length or a meeting's scheduled span. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

// ───────────────────────────── invitations ─────────────────────────────

/** How someone answered an invite, in the words the agenda uses. */
export type Rsvp = "accepted" | "tentative" | "awaiting" | "declined" | "unknown";

/** Google's `responseStatus` as an {@link Rsvp}. */
export function rsvpOf(responseStatus: string): Rsvp {
  switch (responseStatus) {
    case "accepted":
      return "accepted";
    case "declined":
      return "declined";
    case "tentative":
      return "tentative";
    case "needsAction":
      return "awaiting";
    default:
      return "unknown";
  }
}

export const RSVP_LABELS: Record<Rsvp, string> = {
  accepted: "Accepted",
  tentative: "Maybe",
  awaiting: "Awaiting reply",
  declined: "Declined",
  unknown: "No reply on file",
};

export const RSVP_TONES: Record<Rsvp, BadgeTone> = {
  accepted: "success",
  tentative: "warning",
  awaiting: "neutral",
  declined: "danger",
  unknown: "neutral",
};

/** The order replies are counted and listed in: who is coming first. */
export const RSVP_ORDER: Rsvp[] = ["accepted", "tentative", "awaiting", "declined", "unknown"];

export function rsvpCounts(people: Array<{ responseStatus: string }>): Record<Rsvp, number> {
  const counts: Record<Rsvp, number> = {
    accepted: 0,
    tentative: 0,
    awaiting: 0,
    declined: 0,
    unknown: 0,
  };
  for (const person of people) counts[rsvpOf(person.responseStatus)] += 1;
  return counts;
}

/** The name to show for an attendee: the invite's, the Contact's, then the address. */
export function attendeeName(attendee: {
  email: string;
  displayName: string;
  contactName?: string;
}): string {
  return attendee.displayName || attendee.contactName || attendee.email;
}

/** Who "Email attendees" writes to — everyone, or only those who answered one way. */
export type AttendeeAudience = "everyone" | "coming" | "awaiting";

export const AUDIENCE_LABELS: Record<AttendeeAudience, string> = {
  everyone: "Everyone invited",
  coming: "Who accepted or said maybe",
  awaiting: "Who hasn’t replied",
};

/**
 * The addresses an email to an event's attendees goes to.
 *
 * Leaves out the addresses in `exclude` — the calendar's own, since writing
 * to yourself about your own meeting is never what was meant — and anyone
 * listed twice. "Who hasn't replied" counts an attendee with no reply on file
 * too: nothing says they are coming.
 */
export function attendeeRecipients(
  attendees: Array<{ email: string; responseStatus: string }>,
  audience: AttendeeAudience,
  exclude: string[] = [],
): string[] {
  const skip = new Set(exclude.map((email) => email.trim().toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const attendee of attendees) {
    const email = attendee.email.trim().toLowerCase();
    if (!email || skip.has(email)) continue;
    const rsvp = rsvpOf(attendee.responseStatus);
    if (audience === "coming" && rsvp !== "accepted" && rsvp !== "tentative") continue;
    if (audience === "awaiting" && rsvp !== "awaiting" && rsvp !== "unknown") continue;
    skip.add(email);
    out.push(email);
  }
  return out;
}

/** A local `YYYY-MM-DD`: the agenda's `?date=`, the first day it shows. */
export function agendaDateParam(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The agenda, on the week an event falls in, with that event open. */
export function agendaEventPath(companySlug: string, eventId: string, startAt: string): string {
  const query = new URLSearchParams({ date: agendaDateParam(new Date(startAt)), event: eventId });
  return `/c/${companySlug}/meetings?${query.toString()}`;
}

/** `10:00 – 11:00`, or `All day`. */
export function formatTimeRange(event: {
  startAt: string;
  endAt: string;
  allDay: boolean;
}): string {
  if (event.allDay) return "All day";
  return `${formatClock(event.startAt)} – ${formatClock(event.endAt)}`;
}

/**
 * The subject and body an email to a meeting's attendees starts from.
 *
 * The body leaves room to write at the top and keeps the meeting's details
 * underneath, so whoever reads it knows which call it is about and has the
 * link to join it — the two things a note to attendees most often lacks.
 */
export function attendeeEmailDraft(meeting: {
  title: string;
  startAt: string | null;
  endAt: string | null;
  allDay?: boolean;
  conferenceUrl: string;
  location?: string;
}): { subject: string; bodyText: string } {
  const title = meeting.title.trim() || "Our meeting";
  const details = [title];
  if (meeting.startAt) {
    const day = new Date(meeting.startAt).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const time = meeting.allDay
      ? "All day"
      : meeting.endAt
        ? formatTimeRange({ startAt: meeting.startAt, endAt: meeting.endAt, allDay: false })
        : formatClock(meeting.startAt);
    details.push(`${day} · ${time}`);
  }
  const location = meeting.location?.trim() ?? "";
  if (meeting.conferenceUrl) details.push(`Join: ${meeting.conferenceUrl}`);
  else if (location) details.push(`Where: ${location}`);
  return { subject: title, bodyText: `Hi all,\n\n\n\n—\n${details.join("\n")}\n` };
}
