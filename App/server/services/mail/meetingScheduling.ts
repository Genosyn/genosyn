import { randomUUID } from "node:crypto";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import type { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import type { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import {
  currentGoogleGrantedScope,
  hasGoogleCalendarWriteScope,
} from "../../integrations/providers/google/auth.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  MAX_MEETING_MINUTES,
  MIN_MEETING_MINUTES,
  isMeetingTimeZone,
  utcToZonedLocal,
  zonedLocalToUtc,
} from "../../../shared/meetingTime.js";
import { recordAudit, withAuditContext } from "../audit.js";
import { PolicyBlockedRecipientError } from "../companyPolicies.js";
import { decryptConnectionConfig, getConnection } from "../integrations.js";
import { accessTokenForAccount, freshCalendarAccessToken } from "../meetings/accounts.js";
import { googleErrorText, type GoogleCalendarEvent } from "../meetings/calendarClient.js";
import { upsertEvent } from "../meetings/calendarSync.js";
import { conferenceForEvent } from "../meetings/conference.js";
import { markScheduleMeetingActionDone } from "./analysisActions.js";
import { SuppressedRecipientError, assertRecipientsAllowed } from "./suppression.js";

/**
 * Scheduling a meeting from an email: the Google Calendar event, its Meet
 * link and the invitations, created by the Member who pressed Send invite.
 *
 * The event is written with the wall time and IANA zone the Member confirmed
 * (`2026-10-28T15:00` in `Europe/Berlin`), never a bare instant, so Google
 * applies daylight saving the way the people on the thread meant it and each
 * guest's invitation shows the slot in their own zone.
 *
 * Invitations are email, so the guest list goes through the same do-not-email
 * and Policy gate as a send (`assertRecipientsAllowed`) before Google is asked
 * for anything. Calendars come from two places, both already authorized by an
 * owner or admin: a calendar connected under Meetings → Calendars, or the
 * mailbox's own Google account when its consent included Calendar write
 * access. Nothing here creates a Connection or widens a consent.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/** Long enough for Google to mint a Meet conference, short enough not to hang a click. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Re-reads of an event whose Meet link Google is still creating. */
const MEET_LINK_POLLS = 3;
const MEET_LINK_POLL_MS = 700;
const MAX_ATTENDEES = 100;
/** How far ahead a meeting may be booked from an email. */
const MAX_LEAD_DAYS = 730;

export const SCHEDULING_SETUP_HINT =
  "Connect a Google calendar under Meetings → Calendars, or reconnect this mailbox's Google account with Calendar access.";

/** Carries the HTTP status the route answers with. */
export class MeetingSchedulingError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MeetingSchedulingError";
    this.status = status;
  }
}

export type SchedulingCalendar = {
  /** `calendar:<CalendarAccount id>`, or `mailbox` for the mailbox's own Google calendar. */
  id: string;
  label: string;
  address: string;
  /** The calendar's own IANA zone, or "" when it is not known. */
  timeZone: string;
  isDefault: boolean;
};

export type SchedulingCalendarList = {
  calendars: SchedulingCalendar[];
  /** What to do when there is nothing to schedule on; null otherwise. */
  setupHint: string | null;
};

/** One calendar an event can be created on, with what it takes to reach it. */
type SchedulingTarget = {
  option: SchedulingCalendar;
  /** Google's id for the calendar: `primary`, or a shared calendar's id. */
  googleCalendarId: string;
  /** The organizer's own addresses — invited already, so never on the guest list. */
  organizer: string[];
  connectionId: string;
  /** The Meetings mirror the event lands in, when the calendar is connected there. */
  calendarAccount: CalendarAccount | null;
};

export type MeetingSchedulingDependencies = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** A fresh Calendar access token for a target; the default refreshes and persists it. */
  accessToken?: (target: SchedulingTarget, account: MailAccount) => Promise<string>;
};

// ───────────────────────────── calendars ─────────────────────────────

/**
 * Whether a Connection's consent lets it create events. Read from the stored
 * grant, so listing calendars never calls Google. A connection that cannot be
 * read answers "no" and is simply not offered.
 */
function connectionCanWriteEvents(connection: IntegrationConnection | null): boolean {
  if (!connection || connection.provider !== "google") return false;
  try {
    const scope = currentGoogleGrantedScope({
      authMode: connection.authMode,
      config: decryptConnectionConfig(connection),
      setConfig() {},
    });
    return hasGoogleCalendarWriteScope(scope);
  } catch {
    return false;
  }
}

async function schedulingTargets(account: MailAccount): Promise<SchedulingTarget[]> {
  const calendars = await AppDataSource.getRepository(CalendarAccount).find({
    where: { companyId: account.companyId, status: "active" },
    order: { createdAt: "ASC" },
  });
  const writable = new Map<string, boolean>();
  const canWrite = async (connectionId: string): Promise<boolean> => {
    const known = writable.get(connectionId);
    if (known !== undefined) return known;
    const verdict = connectionCanWriteEvents(await getConnection(account.companyId, connectionId));
    writable.set(connectionId, verdict);
    return verdict;
  };

  const targets: SchedulingTarget[] = [];
  for (const calendar of calendars) {
    if (!(await canWrite(calendar.connectionId))) continue;
    targets.push({
      option: {
        id: `calendar:${calendar.id}`,
        label: calendar.displayName || calendar.address || calendar.calendarId,
        address: calendar.address,
        timeZone: isMeetingTimeZone(calendar.timeZone) ? calendar.timeZone : "",
        isDefault: false,
      },
      googleCalendarId: calendar.calendarId,
      organizer: [calendar.address, calendar.calendarId],
      connectionId: calendar.connectionId,
      calendarAccount: calendar,
    });
  }

  // The mailbox's own Google account, unless Meetings already mirrors that
  // same primary calendar — then it is listed once, as that calendar.
  if (account.provider === "gmail") {
    const mirrored = calendars.some(
      (calendar) =>
        calendar.connectionId === account.connectionId && calendar.calendarId === "primary",
    );
    if (!mirrored && (await canWrite(account.connectionId))) {
      targets.push({
        option: {
          id: "mailbox",
          label: account.address,
          address: account.address,
          timeZone: "",
          isDefault: false,
        },
        googleCalendarId: "primary",
        organizer: [account.address],
        connectionId: account.connectionId,
        calendarAccount: null,
      });
    }
  }

  const self = normalizeEmail(account.address);
  const sameAddress = targets.filter((target) => normalizeEmail(target.option.address) === self);
  const preferred =
    sameAddress.find((target) => target.googleCalendarId === "primary") ??
    sameAddress[0] ??
    targets.find((target) => target.option.id === "mailbox") ??
    targets[0];
  if (preferred) preferred.option.isDefault = true;
  return targets;
}

/** The calendars a meeting from this mailbox can go on, the likely one marked default. */
export async function listSchedulingCalendars(
  account: MailAccount,
): Promise<SchedulingCalendarList> {
  const targets = await schedulingTargets(account);
  return {
    calendars: targets.map((target) => target.option),
    setupHint: targets.length > 0 ? null : SCHEDULING_SETUP_HINT,
  };
}

async function resolveTarget(account: MailAccount, calendarId: string): Promise<SchedulingTarget> {
  const target = (await schedulingTargets(account)).find(
    (candidate) => candidate.option.id === calendarId,
  );
  if (!target) {
    throw new MeetingSchedulingError(
      "That calendar can't be used for scheduling from this mailbox. Pick another one.",
      404,
    );
  }
  return target;
}

async function defaultAccessToken(target: SchedulingTarget, account: MailAccount): Promise<string> {
  if (target.calendarAccount) return accessTokenForAccount(target.calendarAccount);
  const connection = await getConnection(account.companyId, target.connectionId);
  if (!connection) {
    throw new Error("The Google connection behind this mailbox was removed.");
  }
  return freshCalendarAccessToken(connection);
}

async function accessTokenFor(
  target: SchedulingTarget,
  account: MailAccount,
  dependencies: MeetingSchedulingDependencies,
): Promise<string> {
  try {
    return await (dependencies.accessToken ?? defaultAccessToken)(target, account);
  } catch (error) {
    throw new MeetingSchedulingError(
      error instanceof Error ? error.message : "Couldn't sign in to Google Calendar.",
    );
  }
}

// ───────────────────────────── Google Calendar ─────────────────────────────

async function calendarRequest<T>(
  dependencies: MeetingSchedulingDependencies,
  accessToken: string,
  args: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<T> {
  const url = new URL(`${CALENDAR_API}${args.path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(args.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MeetingSchedulingError("Google Calendar did not respond within 30s. Try again.");
    }
    throw new MeetingSchedulingError(
      `Couldn't reach Google Calendar: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const message =
      googleErrorText(await response.text().catch(() => "")) ||
      `${response.status} ${response.statusText}`.trim();
    if (response.status === 401) {
      throw new MeetingSchedulingError(
        "Google turned down this calendar's sign-in. Reconnect the Google account and try again.",
      );
    }
    if (response.status === 403) {
      throw new MeetingSchedulingError(`Google Calendar refused: ${message}`);
    }
    if (response.status === 404) {
      throw new MeetingSchedulingError("Google Calendar couldn't find that calendar.");
    }
    throw new MeetingSchedulingError(`Google Calendar: ${message}`);
  }
  return (await response.json()) as T;
}

type CreatedEvent = GoogleCalendarEvent & {
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
};

/** The video link Google attached, from `conferenceData` or the older `hangoutLink`. */
export function meetLinkOf(event: CreatedEvent): string | null {
  const conference = conferenceForEvent({
    conferenceData: event.conferenceData,
    hangoutLink: event.hangoutLink,
  });
  return conference.url || null;
}

function conferencePending(event: CreatedEvent): boolean {
  return event.conferenceData?.createRequest?.status?.statusCode === "pending";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ───────────────────────────── availability ─────────────────────────────

export type BusyInterval = { start: string; end: string };

/** The organizer's busy time on that calendar between `start` and `end`. */
export async function calendarAvailability(
  account: MailAccount,
  input: { calendarId: string; start: Date; end: Date },
  dependencies: MeetingSchedulingDependencies = {},
): Promise<{ busy: BusyInterval[] }> {
  const target = await resolveTarget(account, input.calendarId);
  const token = await accessTokenFor(target, account, dependencies);
  const result = await calendarRequest<{
    calendars?: Record<
      string,
      { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }
    >;
  }>(dependencies, token, {
    method: "POST",
    path: "/freeBusy",
    body: {
      timeMin: input.start.toISOString(),
      timeMax: input.end.toISOString(),
      items: [{ id: target.googleCalendarId }],
    },
  });
  const entry =
    result.calendars?.[target.googleCalendarId] ?? Object.values(result.calendars ?? {})[0];
  const failure = entry?.errors?.[0];
  if (failure) {
    throw new MeetingSchedulingError(
      `Google Calendar couldn't share this calendar's availability (${failure.reason ?? "unknown reason"}).`,
    );
  }
  const busy: BusyInterval[] = [];
  for (const interval of entry?.busy ?? []) {
    const start = new Date(interval.start ?? "");
    const end = new Date(interval.end ?? "");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    busy.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return { busy };
}

// ───────────────────────────── create ─────────────────────────────

export type ScheduleMeetingInput = {
  calendarId: string;
  title: string;
  description?: string;
  /** Local wall time `YYYY-MM-DDTHH:mm` in `timeZone`. */
  start: string;
  timeZone: string;
  durationMinutes: number;
  attendees: Array<{ email: string; name?: string }>;
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

/**
 * The guest list Google receives: valid addresses, each once (case does not
 * make a second person), without the organizer, whom Google adds itself.
 */
export function inviteList(
  attendees: Array<{ email: string; name?: string }>,
  organizer: string[],
): Array<{ email: string; name: string }> {
  const excluded = new Set(
    organizer.map((address) => normalizeEmail(address)).filter((email): email is string => !!email),
  );
  const guests = new Map<string, { email: string; name: string }>();
  for (const attendee of attendees) {
    const email = normalizeEmail(attendee.email);
    if (!email) {
      throw new MeetingSchedulingError(`“${attendee.email}” isn't a valid email address.`);
    }
    if (excluded.has(email)) continue;
    const name = (attendee.name ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const seen = guests.get(email);
    if (!seen) guests.set(email, { email, name });
    else if (!seen.name && name) seen.name = name;
  }
  return [...guests.values()];
}

/**
 * Create the event, attach a Google Meet when asked, and have Google email
 * the invitations. Returns what was created, Meet link included when Google
 * produced one in time.
 */
export async function scheduleMeeting(
  account: MailAccount,
  input: ScheduleMeetingInput,
  /** The Member who booked it, or the AI Employee through `schedule_meeting`. */
  actor: { userId: string | null; employeeId?: string },
  dependencies: MeetingSchedulingDependencies = {},
): Promise<ScheduledMeeting> {
  const now = dependencies.now?.() ?? new Date();
  const target = await resolveTarget(account, input.calendarId);

  let thread: MailThread | null = null;
  if (input.threadId) {
    thread = await AppDataSource.getRepository(MailThread).findOneBy({
      id: input.threadId,
      accountId: account.id,
      companyId: account.companyId,
    });
    if (!thread) throw new MeetingSchedulingError("Thread not found", 404);
  }

  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title) throw new MeetingSchedulingError("Give the meeting a title.");
  const description = (input.description ?? "").trim().slice(0, 8_000);
  const timeZone = input.timeZone;
  if (!isMeetingTimeZone(timeZone)) {
    throw new MeetingSchedulingError("Pick a time zone such as Europe/Berlin.");
  }
  const duration = Math.round(input.durationMinutes);
  if (!(duration >= MIN_MEETING_MINUTES && duration <= MAX_MEETING_MINUTES)) {
    throw new MeetingSchedulingError(
      `A meeting runs between ${MIN_MEETING_MINUTES} minutes and ${MAX_MEETING_MINUTES / 60} hours.`,
    );
  }
  const startAt = zonedLocalToUtc(input.start, timeZone);
  if (!startAt) throw new MeetingSchedulingError("That start time isn't a real date and time.");
  if (startAt.getTime() <= now.getTime()) {
    throw new MeetingSchedulingError("That time has already passed");
  }
  if (startAt.getTime() > now.getTime() + MAX_LEAD_DAYS * 86_400_000) {
    throw new MeetingSchedulingError("That date is more than two years away.");
  }
  const endAt = new Date(startAt.getTime() + duration * 60_000);
  // Read back from the instant: a time inside a daylight-saving gap is sent
  // as the wall time it really lands on, so Google and the reply agree.
  const startLocal = utcToZonedLocal(startAt, timeZone);
  const endLocal = utcToZonedLocal(endAt, timeZone);

  const guests = inviteList(input.attendees, [...target.organizer, account.address]);
  if (guests.length === 0) {
    throw new MeetingSchedulingError(
      "Add at least one person to invite — the calendar's owner is the organizer already.",
    );
  }
  if (guests.length > MAX_ATTENDEES) {
    throw new MeetingSchedulingError(`A meeting can invite at most ${MAX_ATTENDEES} people.`);
  }

  // Invitations are email. The guests clear the same gate a send does, before
  // Google is asked to create anything.
  try {
    await assertRecipientsAllowed(account.companyId, {
      to: guests.map((guest) => guest.email).join(", "),
    });
  } catch (error) {
    if (error instanceof SuppressedRecipientError || error instanceof PolicyBlockedRecipientError) {
      throw new MeetingSchedulingError(error.message);
    }
    throw error;
  }

  const token = await accessTokenFor(target, account, dependencies);
  const calendarPath = `/calendars/${encodeURIComponent(target.googleCalendarId)}/events`;
  let event = await calendarRequest<CreatedEvent>(dependencies, token, {
    method: "POST",
    path: calendarPath,
    query: { conferenceDataVersion: "1", sendUpdates: input.sendInvites ? "all" : "none" },
    body: {
      summary: title,
      ...(description ? { description } : {}),
      start: { dateTime: `${startLocal}:00`, timeZone },
      end: { dateTime: `${endLocal}:00`, timeZone },
      attendees: guests.map((guest) =>
        guest.name ? { email: guest.email, displayName: guest.name } : { email: guest.email },
      ),
      ...(input.addMeet
        ? {
            conferenceData: {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
    },
  });

  // Google may still be minting the conference when the create returns. The
  // event already exists either way, so a failed re-read costs only the link.
  let meetLink = input.addMeet ? meetLinkOf(event) : null;
  const createdId = event.id;
  if (input.addMeet && !meetLink && createdId) {
    for (let poll = 1; poll <= MEET_LINK_POLLS && conferencePending(event); poll += 1) {
      await (dependencies.sleep ?? sleep)(MEET_LINK_POLL_MS * poll);
      try {
        event = await calendarRequest<CreatedEvent>(dependencies, token, {
          method: "GET",
          path: `${calendarPath}/${encodeURIComponent(createdId)}`,
          query: { conferenceDataVersion: "1" },
        });
      } catch {
        break;
      }
      meetLink = meetLinkOf(event);
      if (meetLink) break;
    }
  }

  // The Meetings agenda shows it at once instead of after the next sync pass.
  if (target.calendarAccount) {
    try {
      await upsertEvent(target.calendarAccount, event);
    } catch {
      // The mirror catches up on its next pass; the meeting itself exists.
    }
  }

  const scheduled: ScheduledMeeting = {
    eventId: event.id ?? "",
    calendarId: target.option.id,
    htmlLink: event.htmlLink ?? "",
    meetLink,
    title,
    start: startAt.toISOString(),
    end: endAt.toISOString(),
    timeZone,
    attendees: guests.map((guest) => guest.email),
    invitesSent: input.sendInvites,
  };

  const audit = () =>
    recordAudit({
      companyId: account.companyId,
      actorUserId: actor.userId,
      actorEmployeeId: actor.employeeId ?? null,
      action: "mail.meeting.schedule",
      targetType: thread ? "mail_thread" : "mail_account",
      targetId: thread?.id ?? account.id,
      targetLabel: title,
      metadata: {
        calendarId: target.option.id,
        eventId: scheduled.eventId,
        attendeeCount: guests.length,
        addMeet: input.addMeet,
        sendInvites: input.sendInvites,
        meetLink: meetLink !== null,
        startAt: scheduled.start,
        endAt: scheduled.end,
        timeZone,
      },
    });
  if (thread) await withAuditContext({ mailThreadId: thread.id }, audit);
  else await audit();

  if (thread && input.analysisAction) {
    try {
      await markScheduleMeetingActionDone(account, thread.id, input.analysisAction);
    } catch {
      // The meeting exists; a button left armed is the smaller problem.
    }
  }

  return scheduled;
}
