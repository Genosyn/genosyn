import { TIME_ZONE_NAME } from "./timeZone.js";

/**
 * Wall-clock time in a named zone, for meetings scheduled from an email.
 *
 * A meeting is agreed in words — "Tuesday at 3pm CET works" — so what the
 * scheduler holds is a local wall time (`2026-10-28T15:00`) plus the IANA zone
 * it was said in, never a bare instant. Google Calendar takes exactly that pair
 * and applies daylight saving itself, so the event lands at the hour people
 * agreed even when the two sides of the email are in different zones.
 *
 * These helpers turn the pair into an instant (to show it in the reader's own
 * zone, check a calendar for conflicts, or refuse a time in the past) and back.
 * They lean on the runtime's `Intl` tables rather than a time zone library, the
 * same way `server/lib/timeZone.ts` does, and the browser and the server share
 * them so the two never disagree about when a meeting is.
 */

/** `YYYY-MM-DDTHH:mm` — the local wall time a meeting starts at. */
export const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Durations the scheduler offers, in minutes. Any whole minute 5–720 is accepted. */
export const MEETING_DURATIONS = [15, 30, 45, 60, 90, 120] as const;
export const MIN_MEETING_MINUTES = 5;
export const MAX_MEETING_MINUTES = 720;

/** The longest IANA identifier is 32 characters; this leaves room to spare. */
const MAX_TIME_ZONE_LENGTH = 64;

const zoneVerdicts = new Map<string, boolean>();

/** Whether `name` is an IANA zone this runtime knows. Fixed offsets are refused. */
export function isMeetingTimeZone(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (!name || name.length > MAX_TIME_ZONE_LENGTH || !TIME_ZONE_NAME.test(name)) return false;
  const known = zoneVerdicts.get(name);
  if (known !== undefined) return known;
  let valid = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    valid = true;
  } catch {
    // RangeError: the runtime does not know this zone.
  }
  if (zoneVerdicts.size > 512) zoneVerdicts.clear();
  zoneVerdicts.set(name, valid);
  return valid;
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone: string): ZonedParts {
  let formatter = partFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (partFormatters.size > 64) partFormatters.clear();
    partFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  const hour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some engines still say 24 for midnight under h23.
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Minutes the zone is ahead of UTC at `date` (CET is 60, EDT is -240). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

/** The pieces of a `YYYY-MM-DDTHH:mm` string, or null when it is not a real time. */
export function parseLocalDateTime(local: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  // Date.UTC rolls 31 February into March; a calendar day that does not exist is refused.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, hour, minute };
}

/**
 * The instant a wall time in `timeZone` names. Two passes settle the offset
 * across a daylight-saving change; a time inside the spring-forward gap lands
 * just after it, as calendars do.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const parts = parseLocalDateTime(local);
  if (!parts || !isMeetingTimeZone(timeZone)) return null;
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const first = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  const second = naive - zoneOffsetMinutes(new Date(first), timeZone) * 60_000;
  return new Date(second);
}

/** The wall time `date` shows in `timeZone`, as `YYYY-MM-DDTHH:mm`. */
export function utcToZonedLocal(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** What a zone calls itself at a moment: `CET`, `EDT`, or `GMT+5:30` where it has no name. */
export function timeZoneShortName(timeZone: string, at: Date, locale?: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((item) => item.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** `Europe/Berlin` → `Berlin`, `America/Argentina/Buenos_Aires` → `Buenos Aires`. */
export function timeZoneCity(timeZone: string): string {
  const last = timeZone.split("/").pop() ?? timeZone;
  return last.replace(/_/g, " ");
}

/**
 * "Tue, Oct 28, 3:00 – 3:30 PM CET" — a meeting's slot as people in that
 * zone read it, with the zone named so nobody has to guess whose 3 PM it is.
 */
export function formatMeetingRange(
  start: Date,
  end: Date,
  timeZone: string,
  locale?: string,
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  const zone = timeZoneShortName(timeZone, start, locale);
  try {
    const formatter = new Intl.DateTimeFormat(locale, options) as Intl.DateTimeFormat & {
      formatRange?: (a: Date, b: Date) => string;
    };
    if (typeof formatter.formatRange === "function") {
      return `${formatter.formatRange(start, end)} ${zone}`;
    }
    const time = new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    });
    return `${formatter.format(start)} – ${time.format(end)} ${zone}`;
  } catch {
    return `${start.toISOString()} – ${end.toISOString()}`;
  }
}

/** "3:00 PM" in `timeZone`. */
export function formatMeetingTime(at: Date, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(
      at,
    );
  } catch {
    return at.toISOString();
  }
}

/** Every zone the runtime knows, UTC included, for a picker. */
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) {
    zones = [
      "America/Los_Angeles",
      "America/Denver",
      "America/Chicago",
      "America/New_York",
      "America/Sao_Paulo",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Paris",
      "Africa/Johannesburg",
      "Asia/Dubai",
      "Asia/Kolkata",
      "Asia/Singapore",
      "Asia/Tokyo",
      "Australia/Sydney",
    ];
  }
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** `Re: Re: Fwd: Pricing call` → `Pricing call`. */
export function meetingTitleFromSubject(subject: string): string {
  let title = subject.trim();
  for (;;) {
    const next = title.replace(/^(re|fwd?|aw|wg|sv|tr|antw)\s*(\[\d+\])?\s*:\s*/i, "").trim();
    if (next === title) break;
    title = next;
  }
  return title;
}

/** The wall time `minutes` after `local` in `timeZone`, honouring daylight saving. */
export function addMinutesToLocal(local: string, minutes: number, timeZone: string): string | null {
  const start = zonedLocalToUtc(local, timeZone);
  if (!start) return null;
  return utcToZonedLocal(new Date(start.getTime() + minutes * 60_000), timeZone);
}
