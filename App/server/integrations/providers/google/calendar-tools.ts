import type { IntegrationTool } from "../../types.js";
import { clampInt, googleJsonFetch, optionalString, requireString } from "./util.js";

/**
 * Google Calendar tool family. Hosted under the umbrella `google` provider —
 * the umbrella refreshes the access token before dispatching here.
 *
 * Scope: `https://www.googleapis.com/auth/calendar` (full read/write). The
 * narrower `calendar.events` and `calendar.readonly` scopes are not
 * requested by the umbrella; if a Workspace admin restricts the OAuth app
 * to `calendar.readonly`, the write tools will surface Google's 403 to the
 * caller verbatim.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export const calendarTools: IntegrationTool[] = [
  {
    name: "calendar_list_calendars",
    description:
      "List the calendars the connected account can access (primary + subscribed). Use the returned `id` for other calendar tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "calendar_list_events",
    description:
      "List events on a calendar. Defaults to the primary calendar and the next 30 days. Combine `q` with `timeMin`/`timeMax` to narrow.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar id; defaults to 'primary'.",
        },
        timeMin: {
          type: "string",
          description: "RFC3339 lower bound (inclusive). Defaults to now.",
        },
        timeMax: {
          type: "string",
          description: "RFC3339 upper bound (exclusive). Defaults to now + 30 days.",
        },
        q: {
          type: "string",
          description: "Free-text search across summary, description, attendees.",
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 250,
          description: "Max events (default 50).",
        },
        pageToken: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_get_event",
    description: "Fetch one event by id, including attendees and conferencing details.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event",
    description:
      "Create an event on a calendar. Times are RFC3339 with offset; for all-day events pass `startDate`/`endDate` (YYYY-MM-DD) instead. Set `addMeetLink: true` to attach a Google Meet conference (requires the Workspace policy that allows it).",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        startDateTime: { type: "string", description: "RFC3339, e.g. 2026-05-01T15:00:00-07:00" },
        endDateTime: { type: "string" },
        startDate: { type: "string", description: "All-day start (YYYY-MM-DD)." },
        endDate: { type: "string", description: "All-day end, exclusive." },
        timeZone: { type: "string", description: "IANA tz, e.g. America/Los_Angeles." },
        attendees: {
          type: "array",
          items: { type: "string", description: "Attendee email address." },
        },
        addMeetLink: { type: "boolean" },
        sendUpdates: {
          type: "string",
          enum: ["all", "externalOnly", "none"],
          description: "Whether to email attendees about the new event.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_update_event",
    description:
      "Patch an existing event. Pass only the fields you want to change. To reschedule pass new `startDateTime`/`endDateTime` (or `startDate`/`endDate` for all-day).",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        startDateTime: { type: "string" },
        endDateTime: { type: "string" },
        startDate: { type: "string" },
        endDate: { type: "string" },
        timeZone: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"] },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_delete_event",
    description: "Cancel an event by id. Set `sendUpdates` to control attendee notifications.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        eventId: { type: "string" },
        sendUpdates: { type: "string", enum: ["all", "externalOnly", "none"] },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
];

export const calendarToolNames = new Set(calendarTools.map((t) => t.name));

export async function invokeCalendarTool(
  name: string,
  args: unknown,
  accessToken: string,
): Promise<unknown> {
  const a = (args as Record<string, unknown>) ?? {};
  const calendarId = optionalString(a.calendarId) ?? "primary";

  switch (name) {
    case "calendar_list_calendars":
      return calendarFetch(accessToken, "/users/me/calendarList");

    case "calendar_list_events": {
      const now = new Date();
      const timeMin = optionalString(a.timeMin) ?? now.toISOString();
      const timeMax =
        optionalString(a.timeMax) ??
        new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      return googleJsonFetch({
        accessToken,
        baseUrl: CALENDAR_API,
        path: `/calendars/${encodeURIComponent(calendarId)}/events`,
        productLabel: "Calendar",
        query: {
          timeMin,
          timeMax,
          q: optionalString(a.q),
          maxResults: clampInt(a.maxResults, 1, 250, 50),
          singleEvents: "true",
          orderBy: "startTime",
          pageToken: optionalString(a.pageToken),
        },
      });
    }

    case "calendar_get_event":
      return calendarFetch(
        accessToken,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(requireString(a.eventId, "eventId"))}`,
      );

    case "calendar_create_event":
      return createOrUpdateEvent(accessToken, calendarId, a, "create");

    case "calendar_update_event":
      return createOrUpdateEvent(accessToken, calendarId, a, "update");

    case "calendar_delete_event": {
      const eventId = requireString(a.eventId, "eventId");
      const sendUpdates = optionalString(a.sendUpdates);
      const url = new URL(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
      if (sendUpdates) url.searchParams.set("sendUpdates", sendUpdates);
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok && res.status !== 410) {
        const text = await res.text();
        throw new Error(text || `Calendar ${res.status} ${res.statusText}`);
      }
      return { ok: true, eventId };
    }

    default:
      throw new Error(`Unknown Calendar tool: ${name}`);
  }
}

async function createOrUpdateEvent(
  accessToken: string,
  calendarId: string,
  a: Record<string, unknown>,
  mode: "create" | "update",
): Promise<unknown> {
  const body = buildEventBody(a, mode === "create");
  if (mode === "update") {
    const eventId = requireString(a.eventId, "eventId");
    return googleJsonFetch({
      accessToken,
      baseUrl: CALENDAR_API,
      path: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      method: "PATCH",
      body,
      productLabel: "Calendar",
      query: {
        sendUpdates: optionalString(a.sendUpdates),
      },
    });
  }
  return googleJsonFetch({
    accessToken,
    baseUrl: CALENDAR_API,
    path: `/calendars/${encodeURIComponent(calendarId)}/events`,
    method: "POST",
    body,
    productLabel: "Calendar",
    query: {
      sendUpdates: optionalString(a.sendUpdates),
      conferenceDataVersion: a.addMeetLink === true ? 1 : undefined,
    },
  });
}

function buildEventBody(a: Record<string, unknown>, isCreate: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const summary = optionalString(a.summary);
  if (summary !== undefined) body.summary = summary;
  else if (isCreate) throw new Error("summary is required");

  const description = optionalString(a.description);
  if (description !== undefined) body.description = description;

  const location = optionalString(a.location);
  if (location !== undefined) body.location = location;

  const timeZone = optionalString(a.timeZone);
  const startDateTime = optionalString(a.startDateTime);
  const endDateTime = optionalString(a.endDateTime);
  const startDate = optionalString(a.startDate);
  const endDate = optionalString(a.endDate);

  if (startDateTime || endDateTime) {
    if (startDateTime) body.start = { dateTime: startDateTime, ...(timeZone ? { timeZone } : {}) };
    if (endDateTime) body.end = { dateTime: endDateTime, ...(timeZone ? { timeZone } : {}) };
  } else if (startDate || endDate) {
    if (startDate) body.start = { date: startDate };
    if (endDate) body.end = { date: endDate };
  }

  if (Array.isArray(a.attendees)) {
    body.attendees = a.attendees
      .filter((e): e is string => typeof e === "string" && e.includes("@"))
      .map((email) => ({ email }));
  }

  if (a.addMeetLink === true) {
    body.conferenceData = {
      createRequest: {
        requestId: `gsn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  return body;
}

async function calendarFetch(accessToken: string, path: string): Promise<unknown> {
  return googleJsonFetch({
    accessToken,
    baseUrl: CALENDAR_API,
    path,
    productLabel: "Calendar",
  });
}
