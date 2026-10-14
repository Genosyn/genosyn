/**
 * What a time zone name has to look like: an IANA name such as `UTC` or
 * `Europe/Berlin`.
 *
 * `Intl` decides whether a name is a zone it knows, but it also accepts fixed
 * offsets (`+01:00`), which have no daylight saving and read like a typo for a
 * zone, so a Routine schedule never takes one. The server checks a name
 * against this before it stores it, and the browser before it previews a
 * schedule in it, so the two never disagree about what a zone is.
 */
export const TIME_ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
