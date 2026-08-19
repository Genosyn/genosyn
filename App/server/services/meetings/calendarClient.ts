import { ConnectionAuthError } from "../../integrations/types.js";

/**
 * The Google Calendar HTTP surface the sync loop uses.
 *
 * Deliberately *not* `providers/google/util.ts#googleJsonFetch`, which is
 * built for one-shot LLM tool calls: it has no request timeout and throws a
 * plain `Error`, so a 401 from Google would never mark the Connection expired
 * and a hung socket would wedge a heartbeat pass forever. A sync loop needs
 * both, so it gets its own envelope — the same call the mail subsystem makes
 * for the same reason.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Long enough for a slow list of 250 events, short enough that a wedged
 * socket cannot outlive the heartbeat interval that scheduled it. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Google's "your sync token is too old, start over" signal.
 *
 * It arrives as an HTTP 410 and it is **not an error**: it is an instruction
 * to drop the cursor and re-list the window. Modelled as its own class so the
 * caller can branch on identity rather than on a status code it would have to
 * thread through three layers.
 */
export class CalendarSyncTokenExpiredError extends Error {
  constructor() {
    super("The calendar sync token expired; a full re-list is required.");
    this.name = "CalendarSyncTokenExpiredError";
  }
}

export type CalendarListEntry = {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
};

/** The subset of a Google event this app reads. Everything else is ignored. */
export type GoogleCalendarEvent = {
  id?: string;
  iCalUID?: string;
  recurringEventId?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    organizer?: boolean;
    optional?: boolean;
    resource?: boolean;
    self?: boolean;
  }>;
  conferenceData?: unknown;
};

export type EventsPage = {
  items: GoogleCalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
};

async function calendarFetch<T>(args: {
  accessToken: string;
  path: string;
  query?: Record<string, string | number | undefined>;
}): Promise<T> {
  const url = new URL(`${CALENDAR_API}${args.path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Google Calendar did not respond within 30s.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 410) throw new CalendarSyncTokenExpiredError();

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = googleErrorText(body) || `${res.status} ${res.statusText}`;
    // 401 means the credential is dead; 403 here is almost always a scope the
    // consent never carried. Both make the Connection unusable until somebody
    // reconnects, which is exactly what ConnectionAuthError records.
    if (res.status === 401) throw new ConnectionAuthError(message, "expired");
    if (res.status === 403 && /insufficient|scope|permission/i.test(message)) {
      throw new ConnectionAuthError(message, "error");
    }
    throw new Error(`Google Calendar: ${message}`);
  }

  return (await res.json()) as T;
}

/** Pull the human sentence out of Google's `{error:{message}}` envelope. */
function googleErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return body.slice(0, 300).trim();
}

/** Every calendar this account can see. */
export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
  const page = await calendarFetch<{ items?: CalendarListEntry[] }>({
    accessToken,
    path: "/users/me/calendarList",
    query: { maxResults: 250, minAccessRole: "reader" },
  });
  return page.items ?? [];
}

/**
 * One page of events.
 *
 * `syncToken` and the time window are mutually exclusive in Google's API — a
 * request that sends both is rejected — so the caller passes exactly one and
 * this signature keeps them in separate fields to make that visible.
 *
 * `singleEvents: true` expands a recurring series into instances. That is what
 * makes "the meetings in the next hour" answerable without expanding an RRULE
 * locally, and it is why `showDeleted` is on: an instance that was cancelled
 * has to be able to cancel its local twin.
 */
export async function listEventsPage(args: {
  accessToken: string;
  calendarId: string;
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
  maxResults?: number;
}): Promise<EventsPage> {
  const page = await calendarFetch<{
    items?: GoogleCalendarEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  }>({
    accessToken: args.accessToken,
    path: `/calendars/${encodeURIComponent(args.calendarId)}/events`,
    query: args.syncToken
      ? {
          syncToken: args.syncToken,
          pageToken: args.pageToken,
          maxResults: args.maxResults ?? 250,
          singleEvents: "true",
          showDeleted: "true",
        }
      : {
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          pageToken: args.pageToken,
          maxResults: args.maxResults ?? 250,
          singleEvents: "true",
          showDeleted: "true",
          orderBy: "startTime",
        },
  });
  return {
    items: page.items ?? [],
    nextPageToken: page.nextPageToken ?? null,
    nextSyncToken: page.nextSyncToken ?? null,
  };
}
