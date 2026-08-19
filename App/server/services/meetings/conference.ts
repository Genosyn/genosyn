import type { ConferenceProvider } from "../../db/entities/CalendarEvent.js";

/**
 * Where is this meeting actually happening?
 *
 * The answer is a property of the invite, not of anything a user configures,
 * so it is detected rather than asked for. Google fills `conferenceData` when
 * the meeting was created with a Meet link; everything else in the world
 * pastes a URL into the location or the description, which is why the text
 * scan below exists and why it runs last.
 *
 * The rule this module is built around: **a link we cannot confidently name is
 * still a link.** `other` is a real answer — it means "there is a call here,
 * we just do not know whose" — and it is strictly better than `none`, which
 * the auto-record policy reads as "nothing to join". Guessing `zoom` for a
 * URL that merely says "meet" somewhere would be worse than either.
 */

/**
 * Host suffixes we can name, longest-suffix-wins.
 *
 * Matched against the hostname only, and always on a dot boundary, so
 * `notzoom.us` and `zoom.us.evil.example` do not read as Zoom. A bare
 * equality check on the suffix covers the apex (`zoom.us` itself).
 */
const PROVIDER_HOSTS: Array<{ suffix: string; provider: ConferenceProvider }> = [
  { suffix: "meet.google.com", provider: "meet" },
  { suffix: "hangouts.google.com", provider: "meet" },
  { suffix: "zoom.us", provider: "zoom" },
  { suffix: "zoomgov.com", provider: "zoom" },
  { suffix: "teams.microsoft.com", provider: "teams" },
  { suffix: "teams.live.com", provider: "teams" },
  { suffix: "webex.com", provider: "webex" },
  { suffix: "webex.com.cn", provider: "webex" },
];

/**
 * Scheme-anchored so it cannot match a bare domain in prose, and stopped at
 * whitespace, quotes, and angle brackets because a calendar description is
 * routinely HTML with the URL inside an `href`.
 */
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Trailing punctuation that belongs to the sentence, not to the URL. */
function trimUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}>]+$/, "");
}

/** The provider behind a hostname, or null when we cannot name it. */
export function providerForUrl(url: string): ConferenceProvider | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  // Longest suffix first so `webex.com.cn` is not shadowed by `webex.com`.
  const ordered = [...PROVIDER_HOSTS].sort((a, b) => b.suffix.length - a.suffix.length);
  for (const { suffix, provider } of ordered) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return provider;
  }
  return null;
}

export type ConferenceLink = {
  provider: ConferenceProvider;
  url: string;
};

export const NO_CONFERENCE: ConferenceLink = { provider: "none", url: "" };

/**
 * The `conferenceData.entryPoints` shape Google returns. Only `video` entry
 * points are of interest: a `phone` entry point is a dial-in number and a
 * `more` entry point is a help page, and joining either is not recording a
 * call.
 */
type GoogleEntryPoint = {
  entryPointType?: unknown;
  uri?: unknown;
};

/**
 * Resolve the conference for one Google Calendar event.
 *
 * Order is deliberate and is the whole design:
 *
 * 1. **`conferenceData` video entry points.** Structured, authoritative, and
 *    the only source that survives a description somebody edited.
 * 2. **`hangoutLink`.** Google's older field, still populated on plenty of
 *    events that predate `conferenceData`.
 * 3. **`location`, then `description`.** Free text, scanned for the first URL
 *    we can *name*. A named link anywhere beats an unnamed link earlier —
 *    otherwise a Notion agenda pasted above the Zoom link wins, and the
 *    recorder is pointed at a wiki page.
 *
 * An unnamed URL in `location` is still returned as `other`, because a
 * self-hosted Jitsi is a real meeting; an unnamed URL in `description` is not,
 * because a description is mostly links to documents.
 */
export function conferenceForEvent(event: {
  conferenceData?: unknown;
  hangoutLink?: unknown;
  location?: unknown;
  description?: unknown;
}): ConferenceLink {
  const fromData = conferenceFromData(event.conferenceData);
  if (fromData) return fromData;

  if (typeof event.hangoutLink === "string" && event.hangoutLink.trim()) {
    const url = event.hangoutLink.trim();
    return { provider: providerForUrl(url) ?? "meet", url };
  }

  const location = typeof event.location === "string" ? event.location : "";
  const description = typeof event.description === "string" ? event.description : "";

  // A *named* provider anywhere wins over an unnamed URL anywhere.
  const named = firstNamedLink(`${location}\n${description}`);
  if (named) return named;

  const locationUrl = firstUrl(location);
  if (locationUrl) return { provider: "other", url: locationUrl };

  return NO_CONFERENCE;
}

function conferenceFromData(conferenceData: unknown): ConferenceLink | null {
  if (!conferenceData || typeof conferenceData !== "object") return null;
  const entryPoints = (conferenceData as { entryPoints?: unknown }).entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  for (const raw of entryPoints as GoogleEntryPoint[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.entryPointType !== "video") continue;
    if (typeof raw.uri !== "string" || !raw.uri.trim()) continue;
    const url = raw.uri.trim();
    return { provider: providerForUrl(url) ?? "other", url };
  }
  return null;
}

/** The first URL in `text` whose host we can name. */
function firstNamedLink(text: string): ConferenceLink | null {
  for (const match of text.matchAll(URL_RE)) {
    const url = trimUrlPunctuation(match[0]);
    const provider = providerForUrl(url);
    if (provider) return { provider, url };
  }
  return null;
}

/** The first URL in `text`, named or not. */
function firstUrl(text: string): string | null {
  for (const match of text.matchAll(URL_RE)) {
    return trimUrlPunctuation(match[0]);
  }
  return null;
}
