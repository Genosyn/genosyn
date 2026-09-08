import type { WorkEntry } from "@/lib/api";

const HOUR_MS = 3_600_000;

export type WorkCalendarHour = {
  key: string;
  at: string;
  label: string;
  entries: WorkEntry[];
};

/** A date-input value in the Member's local timezone, rather than UTC's date. */
export function workCalendarDate(nowIso: string): string {
  const date = new Date(nowIso);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid calendar date");
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function localMidnight(date: string): Date {
  const midnight = new Date(`${date}T00:00:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(midnight.getTime()) ||
    workCalendarDate(midnight.toISOString()) !== date
  ) {
    throw new RangeError("Invalid calendar date");
  }
  return midnight;
}

/** Move by calendar dates; adding 24 elapsed hours can skip a local date at DST. */
export function shiftWorkCalendarDate(date: string, offsetDays: number): string {
  const shifted = localMidnight(date);
  shifted.setDate(shifted.getDate() + offsetDays);
  return workCalendarDate(shifted.toISOString());
}

/** The inclusive start and exclusive end of the selected local calendar day. */
export function workCalendarWindow(date: string): { since: string; until: string } {
  const since = localMidnight(date);
  const until = localMidnight(shiftWorkCalendarDate(date, 1));
  return { since: since.toISOString(), until: until.toISOString() };
}

/**
 * Stack every entry at its starting hour, so simultaneous work stays readable.
 * Slots advance in elapsed time: a skipped hour stays absent, and a repeated
 * hour gets two distinct slots and timezone labels instead of merging work.
 */
export function workCalendarHours(date: string, entries: WorkEntry[]): WorkCalendarHour[] {
  const { since, until } = workCalendarWindow(date);
  const start = Date.parse(since);
  const end = Date.parse(until);
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const zonedClock = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  });
  const hours: WorkCalendarHour[] = [];
  const labelCounts = new Map<string, number>();
  for (let at = start; at < end; at += HOUR_MS) {
    const iso = new Date(at).toISOString();
    const label = clock.format(at);
    hours.push({ key: iso, at: iso, label, entries: [] });
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  for (const hour of hours) {
    if ((labelCounts.get(hour.label) ?? 0) > 1) {
      hour.label = zonedClock.format(new Date(hour.at));
    }
  }
  const ordered = entries
    .map((entry) => ({ entry, at: Date.parse(entry.at) }))
    .filter(({ at }) => at >= start && at < end)
    .sort((a, b) => a.at - b.at);
  for (const { entry, at } of ordered) {
    hours[Math.floor((at - start) / HOUR_MS)].entries.push(entry);
  }
  return hours;
}
