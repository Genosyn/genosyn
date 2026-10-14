// The time zones a company can choose for its Routines (Settings → Company).
//
// The browser already knows every IANA zone, so the list is read from it
// rather than shipped: `Intl.supportedValuesOf("timeZone")`, which every
// current browser has. A browser too old to answer gets a short list of the
// zones most people mean, plus its own, so the form still works. The server
// has the final say — it accepts any name its own tables resolve, including
// the legacy spellings (`Asia/Calcutta`) browsers still report for a place.

/** What an older browser offers instead of the full database. */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  "UTC",
  "America/Anchorage",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Sao_Paulo",
  "America/Toronto",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Asia/Bangkok",
  "Asia/Dhaka",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Jakarta",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Manila",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Melbourne",
  "Australia/Perth",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Berlin",
  "Europe/Dublin",
  "Europe/Istanbul",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Moscow",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

/** The zone this browser is in, or null when it will not say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The grouping label for a zone: its region (`Europe`), or "Other" for `UTC` and friends. */
export function timeZoneRegion(zone: string): string {
  const slash = zone.indexOf("/");
  return slash > 0 ? zone.slice(0, slash) : "Other";
}

/**
 * Every zone to offer, sorted, with `extra` names (the company's current one,
 * the browser's own) included even when the browser's list leaves them out —
 * `Intl.supportedValuesOf` has no `UTC`, and may spell a place differently
 * from the name already saved.
 */
export function listTimeZones(extra: ReadonlyArray<string | null | undefined> = []): string[] {
  let known: string[];
  try {
    known = Intl.supportedValuesOf("timeZone");
  } catch {
    known = [...FALLBACK_TIME_ZONES];
  }
  const all = new Set<string>(known);
  all.add("UTC");
  for (const zone of extra) if (zone) all.add(zone);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** Zones grouped under their region, regions in order, `Other` last. */
export function groupTimeZones(zones: readonly string[]): Array<{ region: string; zones: string[] }> {
  const byRegion = new Map<string, string[]>();
  for (const zone of zones) {
    const region = timeZoneRegion(zone);
    const bucket = byRegion.get(region);
    if (bucket) bucket.push(zone);
    else byRegion.set(region, [zone]);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([region, grouped]) => ({ region, zones: grouped }));
}
