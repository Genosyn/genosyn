import { LessThan, MoreThan } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { CalendarEvent, type CalendarEventStatus } from "../../db/entities/CalendarEvent.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { accessTokenForAccount } from "./accounts.js";
import {
  CalendarSyncTokenExpiredError,
  listEventsPage,
  type GoogleCalendarEvent,
} from "./calendarClient.js";
import { conferenceForEvent } from "./conference.js";

/**
 * Mirror a connected calendar into `calendar_events`.
 *
 * Two modes, and which one runs is decided entirely by whether the account
 * holds a `syncToken`:
 *
 *   - **Full window.** No cursor: list `now ± windowDays`, page through, and
 *     keep the `nextSyncToken` Google hands back on the final page.
 *   - **Incremental.** With a cursor: Google returns only what changed since,
 *     including deletions (as `status: "cancelled"` rows, which is why the
 *     client asks for `showDeleted`).
 *
 * The one piece of Google behaviour worth stating out loud is the 410. Google
 * expires a sync token whenever it decides the window is too old, and it is
 * **not an error** — it means "re-list from scratch". Treating it as a failure
 * would park a perfectly healthy calendar in `error` and stop it syncing until
 * a human noticed, so it clears the cursor and retries once instead.
 */

/** Pages per pass. Bounds one account's share of a heartbeat so a calendar
 * with ten thousand events cannot starve every other account behind it. */
const MAX_PAGES_PER_PASS = 10;

export type CalendarSyncResult = {
  upserted: number;
  cancelled: number;
  pruned: number;
  /** True when Google still had more pages than this pass was willing to walk. */
  truncated: boolean;
};

/** RFC3339 bounds for the mirrored window. */
function windowBounds(account: CalendarAccount, now: Date): { timeMin: string; timeMax: string } {
  const span = account.windowDays * 24 * 60 * 60 * 1000;
  return {
    timeMin: new Date(now.getTime() - span).toISOString(),
    timeMax: new Date(now.getTime() + span).toISOString(),
  };
}

/**
 * Google's two date shapes.
 *
 * A timed event carries `dateTime` (an instant). An all-day event carries
 * `date` (a calendar day in the *calendar's* zone, with no instant at all).
 * Parsing the second as UTC midnight is the conventional compromise and is
 * why `allDay` is stored alongside: the UI must not render "01:00" for a
 * day-long event just because the server sits in UTC+1.
 */
function parseEventTime(slot: { dateTime?: string; date?: string } | undefined): {
  at: Date | null;
  allDay: boolean;
} {
  if (!slot) return { at: null, allDay: false };
  if (typeof slot.dateTime === "string" && slot.dateTime) {
    const at = new Date(slot.dateTime);
    return { at: Number.isNaN(at.getTime()) ? null : at, allDay: false };
  }
  if (typeof slot.date === "string" && slot.date) {
    const at = new Date(`${slot.date}T00:00:00.000Z`);
    return { at: Number.isNaN(at.getTime()) ? null : at, allDay: true };
  }
  return { at: null, allDay: false };
}

function eventStatus(raw: string | undefined): CalendarEventStatus {
  if (raw === "cancelled") return "cancelled";
  if (raw === "tentative") return "tentative";
  return "confirmed";
}

/** The attendee shape persisted on the row. Resources (rooms) are dropped —
 * a conference room is not a person and must never reach contact matching. */
export type StoredAttendee = {
  email: string;
  displayName: string;
  responseStatus: string;
  organizer: boolean;
  optional: boolean;
};

export function attendeesFor(event: GoogleCalendarEvent): StoredAttendee[] {
  const out: StoredAttendee[] = [];
  const seen = new Set<string>();
  for (const raw of event.attendees ?? []) {
    if (!raw || raw.resource === true) continue;
    const email = normalizeEmail(raw.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      email,
      displayName: typeof raw.displayName === "string" ? raw.displayName : "",
      responseStatus: typeof raw.responseStatus === "string" ? raw.responseStatus : "",
      organizer: raw.organizer === true,
      optional: raw.optional === true,
    });
  }
  return out;
}

/**
 * Write one Google event into the mirror.
 *
 * Upsert keyed on `(accountId, externalId)` — Google's event id is stable
 * across edits, which is what makes a re-list idempotent rather than a source
 * of duplicates.
 */
async function upsertEvent(
  account: CalendarAccount,
  raw: GoogleCalendarEvent,
): Promise<"upserted" | "cancelled" | "skipped"> {
  const externalId = typeof raw.id === "string" ? raw.id : "";
  if (!externalId) return "skipped";

  const repo = AppDataSource.getRepository(CalendarEvent);
  const existing = await repo.findOneBy({ accountId: account.id, externalId });
  const status = eventStatus(raw.status);

  // A cancellation for an event we never mirrored is not worth a row: there is
  // nothing to show and nothing to clean up.
  if (status === "cancelled" && !existing) return "skipped";

  const start = parseEventTime(raw.start);
  const end = parseEventTime(raw.end);
  // An event with no start cannot be placed on an agenda. Google only does
  // this for cancelled instances, which the branch above has already handled.
  if (!start.at && !existing) return "skipped";

  const conference = conferenceForEvent(raw);
  const startAt = start.at ?? existing?.startAt ?? new Date();
  const endAt = end.at ?? existing?.endAt ?? startAt;
  const remoteUpdatedAt =
    typeof raw.updated === "string" && !Number.isNaN(new Date(raw.updated).getTime())
      ? new Date(raw.updated)
      : null;

  const row =
    existing ??
    repo.create({
      companyId: account.companyId,
      accountId: account.id,
      externalId,
    });

  row.iCalUid = typeof raw.iCalUID === "string" ? raw.iCalUID : row.iCalUid ?? "";
  row.recurringEventId =
    typeof raw.recurringEventId === "string" ? raw.recurringEventId : row.recurringEventId ?? "";
  row.summary = typeof raw.summary === "string" ? raw.summary : "";
  row.description = typeof raw.description === "string" ? raw.description : "";
  row.location = typeof raw.location === "string" ? raw.location : "";
  row.startAt = startAt;
  row.endAt = endAt;
  row.allDay = start.allDay;
  row.status = status;
  row.organizerEmail = normalizeEmail(raw.organizer?.email) ?? "";
  row.organizerName = typeof raw.organizer?.displayName === "string" ? raw.organizer.displayName : "";
  row.attendeesJson = JSON.stringify(attendeesFor(raw));
  row.conferenceProvider = conference.provider;
  row.conferenceUrl = conference.url;
  row.htmlLink = typeof raw.htmlLink === "string" ? raw.htmlLink : "";
  row.remoteUpdatedAt = remoteUpdatedAt;

  await repo.save(row);
  return status === "cancelled" ? "cancelled" : "upserted";
}

/**
 * Drop mirrored events that have fallen outside the window.
 *
 * The mirror is a cache of a moving window, so this is ordinary housekeeping
 * rather than deletion of anything anyone owns. Meetings are untouched: a
 * recorded call keeps its transcript long after the invite ages out, which is
 * exactly why `Meeting` denormalises its own title and times instead of
 * reading them through `calendarEventId`.
 */
async function pruneWindow(account: CalendarAccount, now: Date): Promise<number> {
  const span = account.windowDays * 24 * 60 * 60 * 1000;
  const repo = AppDataSource.getRepository(CalendarEvent);
  const before = await repo.delete({
    accountId: account.id,
    endAt: LessThan(new Date(now.getTime() - span)),
  });
  const after = await repo.delete({
    accountId: account.id,
    startAt: MoreThan(new Date(now.getTime() + span)),
  });
  return (before.affected ?? 0) + (after.affected ?? 0);
}

/**
 * One sync pass over one calendar.
 *
 * Callers get a plain result or an exception; the durable `syncState`
 * bookkeeping lives in {@link runAccountSync} so this function stays testable
 * without a lifecycle around it.
 */
export async function syncCalendarAccount(
  account: CalendarAccount,
  now = new Date(),
): Promise<CalendarSyncResult> {
  const token = await accessTokenForAccount(account);
  const repo = AppDataSource.getRepository(CalendarAccount);

  let upserted = 0;
  let cancelled = 0;
  let truncated = false;

  const walk = async (syncToken: string): Promise<string | null> => {
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_PASS; page += 1) {
      const bounds = windowBounds(account, now);
      const result = await listEventsPage({
        accessToken: token,
        calendarId: account.calendarId,
        syncToken: syncToken || undefined,
        timeMin: syncToken ? undefined : bounds.timeMin,
        timeMax: syncToken ? undefined : bounds.timeMax,
        pageToken,
      });
      for (const raw of result.items) {
        const outcome = await upsertEvent(account, raw);
        if (outcome === "upserted") upserted += 1;
        if (outcome === "cancelled") cancelled += 1;
      }
      if (result.nextSyncToken) nextSyncToken = result.nextSyncToken;
      if (!result.nextPageToken) return nextSyncToken;
      pageToken = result.nextPageToken;
    }
    // More pages than we were willing to walk. The cursor is deliberately NOT
    // stored: a partial page token is not a sync token, and persisting one
    // would make the next pass believe it was up to date.
    truncated = true;
    return null;
  };

  let nextSyncToken: string | null;
  try {
    nextSyncToken = await walk(account.syncToken);
  } catch (err) {
    if (!(err instanceof CalendarSyncTokenExpiredError)) throw err;
    // Not a failure — an instruction. Drop the cursor and re-list once.
    account.syncToken = "";
    await repo.update({ id: account.id }, { syncToken: "" });
    nextSyncToken = await walk("");
  }

  const pruned = await pruneWindow(account, now);

  account.syncToken = nextSyncToken ?? "";
  account.lastSyncAt = now;
  await repo.update(
    { id: account.id },
    { syncToken: account.syncToken, lastSyncAt: account.lastSyncAt },
  );

  return { upserted, cancelled, pruned, truncated };
}
