/**
 * IANA time zone names, as the product accepts them.
 *
 * A company's Routines are scheduled in the zone it names (`Company.timezone`),
 * and the name reaches `cron-parser` — which reads it through `luxon` and the
 * runtime's own `Intl` tables. Anything `Intl` cannot resolve makes
 * `cron-parser` throw, and `nextRunFor()` turns a throw into `null`, which the
 * heartbeat reads as "this Routine can never run". So a name is checked here,
 * at the API, before it is stored, rather than discovered at 3 AM.
 *
 * The check is `Intl` itself, not a list: the tables a server ships with move
 * with its Node build, and a browser reports whatever *its* tables call the
 * viewer's zone (`Asia/Calcutta` rather than `Asia/Kolkata`, for one). Asking
 * the engine that will do the scheduling is the only answer that cannot
 * disagree with it. The name pattern in front of it (`shared/timeZone.ts`,
 * which the browser's schedule preview uses too) only keeps out what `Intl`
 * would accept but a schedule has no business with: fixed offsets
 * (`+01:00`), which have no daylight saving and read like a typo for a zone,
 * and anything that is not plausibly a zone name at all.
 */

import { TIME_ZONE_NAME } from "../../shared/timeZone.js";

/** The longest IANA identifier is 32 characters; this leaves room to spare. */
export const MAX_TIME_ZONE_LENGTH = 64;

/**
 * Constructing an `Intl.DateTimeFormat` costs far more than looking a verdict
 * up, and the scheduler asks about the same few names on every heartbeat. Pure
 * memo: the same name always has the same answer for the life of the process.
 * Bounded so a table full of junk names cannot grow it without limit.
 */
const verdicts = new Map<string, boolean>();
const VERDICT_LIMIT = 512;

/**
 * Whether `name` is an IANA time zone this runtime can schedule in. The empty
 * string is *not* a zone — it means "server time" and is handled by callers.
 */
export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_TIME_ZONE_LENGTH || !TIME_ZONE_NAME.test(name)) {
    return false;
  }
  const known = verdicts.get(name);
  if (known !== undefined) return known;
  let valid = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    valid = true;
  } catch {
    // RangeError: the runtime does not know this zone.
  }
  if (verdicts.size >= VERDICT_LIMIT) verdicts.clear();
  verdicts.set(name, valid);
  return valid;
}
