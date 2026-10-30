/**
 * How many sessions each of an AI Model's API keys carried in the last day —
 * the figure the model's API keys card shows beside each key, so an owner can
 * see the sessions spread across the pool (and a refused key falling behind).
 *
 * A key's sessions are counted by the hour on its health row
 * (`AIModelKeyHealth.sessionsByHour`) as JSON `[[epochHour, sessions], …]`,
 * keeping only the hours inside the window; `modelKeyHealth.ts` writes them.
 * Pure functions, so the card's figure and the stored shape are tested
 * without a database, and anything malformed reads as no sessions.
 */

/** How far back a key's sessions are counted, in hours. */
export const SESSION_WINDOW_HOURS = 24;

const HOUR_MS = 3_600_000;

/** One hour's sessions on a key: `[epochHour, sessions]`. */
export type HourlySessions = [hour: number, sessions: number];

function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS);
}

/**
 * A key's stored sessions by the hour, tolerantly: anything that is not a
 * list of `[hour, count]` pairs of whole numbers reads as no sessions, and an
 * hour listed twice is added up.
 */
export function readSessionsByHour(json: string | null | undefined): HourlySessions[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byHour = new Map<number, number>();
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [hour, sessions] = entry as unknown[];
    if (typeof hour !== "number" || !Number.isSafeInteger(hour)) continue;
    if (typeof sessions !== "number" || !Number.isSafeInteger(sessions) || sessions <= 0) continue;
    byHour.set(hour, (byHour.get(hour) ?? 0) + sessions);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]);
}

/** The hours still inside the window at `now`, oldest first. */
function withinWindow(byHour: readonly HourlySessions[], now: number): HourlySessions[] {
  const oldest = hourOf(now) - SESSION_WINDOW_HOURS + 1;
  return byHour
    .filter(([hour]) => hour >= oldest && hour <= hourOf(now))
    .map(([hour, sessions]): HourlySessions => [hour, sessions]);
}

/** `byHour` with one more session at `at`, and the hours older than the window dropped. */
export function addSession(byHour: readonly HourlySessions[], at: number): HourlySessions[] {
  const hour = hourOf(at);
  const kept = withinWindow(byHour, at);
  const current = kept.find(([h]) => h === hour);
  if (current) current[1] += 1;
  else kept.push([hour, 1]);
  return kept.sort((a, b) => a[0] - b[0]);
}

/** How many sessions a key carried in the last {@link SESSION_WINDOW_HOURS} hours. */
export function sessionsInWindow(json: string | null | undefined, now = Date.now()): number {
  return withinWindow(readSessionsByHour(json), now).reduce((sum, [, n]) => sum + n, 0);
}

/**
 * Two keys' stored sessions as one — the same key on duplicate AI Models that
 * are merged — or null when neither has a session left in the window.
 */
export function combineSessionsByHour(
  a: string | null | undefined,
  b: string | null | undefined,
  now = Date.now(),
): string | null {
  const byHour = new Map<number, number>();
  for (const [hour, sessions] of [...readSessionsByHour(a), ...readSessionsByHour(b)]) {
    byHour.set(hour, (byHour.get(hour) ?? 0) + sessions);
  }
  const kept = withinWindow([...byHour.entries()], now).sort((x, y) => x[0] - y[0]);
  return kept.length > 0 ? JSON.stringify(kept) : null;
}
