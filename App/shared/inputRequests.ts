/**
 * An Input request: something an AI Employee needs from a person that only a
 * person has. A one-time code on their phone, a step on their own device, a fact
 * no tool can reach. These are the words and limits the server and the browser
 * share (`server/services/inputRequests.ts` holds the behaviour).
 *
 * People are not there when the work needs them, and a one-time code dies within
 * seconds. So a request never asks for a code in advance. While a page is really
 * waiting, a person can answer it straight away. If nobody comes, the work stops
 * and costs nothing, and the person says they're ready when they are: only then
 * does the AI Employee sign in again and ask for a code that can still work.
 */

export type InputRequestKind =
  /** A value typed into a waiting page. It never reaches the AI Model. */
  | "code"
  /** Something only a person can do at a waiting page: approve a push, solve a captcha. */
  | "action"
  /** A fact in words, not tied to a page. The AI Employee reads the answer. */
  | "answer";

export type InputRequestStatus =
  /** Nobody has come yet. A page kind waits for "I'm ready"; an answer waits for its words. */
  | "waiting"
  /** A person said they're ready, and the work is on its way back to the page. */
  | "ready"
  /** A page is waiting right now, and a live session is holding it until `askingUntil`. */
  | "asking"
  /** The person gave what the page asked for. The same work may ask again if it was refused. */
  | "submitted"
  /** A person answered in words. */
  | "answered"
  /** A person said they can't. */
  | "declined"
  /** Nobody came before it ran out of time. */
  | "expired"
  /** The work ended without needing it. */
  | "closed";

export const OPEN_INPUT_REQUEST_STATUSES = ["waiting", "ready", "asking"] as const;

export function isInputRequestOpen(status: InputRequestStatus): boolean {
  return (OPEN_INPUT_REQUEST_STATUSES as readonly InputRequestStatus[]).includes(status);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a live session holds a page for a person. It has to sit under what a
 * tool call may wait for (`server/mcp/`: 300 seconds for the browser's own HTTP
 * call), and it doesn't have to be longer: anyone slower than this is back on the
 * "I'm ready" path, which works at any hour.
 */
export const INPUT_REQUEST_ANSWER_WINDOW_MS = 4 * MINUTE_MS;

/** A window too short to be worth a person's trouble: the work pauses at once instead. */
export const INPUT_REQUEST_MIN_WINDOW_MS = 30_000;

/** How long a request stays open before it gives up and the work carries on without it. */
export const INPUT_REQUEST_EXPIRY_MS = 7 * DAY_MS;

/**
 * How long after "I'm ready" the work may take to get back to the page before the
 * request says so and waits for them again. The queue can be busy or an AI Model
 * unavailable, and a person should not stare at a spinner for an hour.
 */
export const INPUT_REQUEST_READY_WAIT_MS = 30 * MINUTE_MS;

/** An AI Employee may have this many requests open at once. */
export const MAX_OPEN_INPUT_REQUESTS_PER_EMPLOYEE = 3;

/** Wrong codes lock accounts, so one request stops asking well before a site would. */
export const MAX_CODES_PER_INPUT_REQUEST = 5;

export const INPUT_REQUEST_TITLE_CHARS = 160;
export const INPUT_REQUEST_BODY_CHARS = 1_000;
export const INPUT_REQUEST_ANSWER_CHARS = 4_000;
export const INPUT_REQUEST_CODE_CHARS = 128;

/**
 * How long until the next reminder, given how many have gone. It backs off fast:
 * an hour, then four, then twelve, then a day, then once a day until the request
 * expires. A person who is away hears about it, without their phone going off
 * every few minutes on a long weekend.
 */
export function inputRequestReminderDelayMs(sent: number): number {
  if (sent <= 0) return HOUR_MS;
  if (sent === 1) return 3 * HOUR_MS;
  if (sent === 2) return 8 * HOUR_MS;
  if (sent === 3) return 12 * HOUR_MS;
  return DAY_MS;
}

/**
 * From this reminder on, the company's owners and admins hear about it too. By now
 * the named person has been reminded for a day and the work is still stuck, and
 * being on holiday shouldn't stop a VAT return being filed.
 */
export const INPUT_REQUEST_ESCALATE_AT_REMINDER = 3;

/** How many reminders go out by a given age, for showing a person what to expect. */
export function inputRequestRemindersBy(ageMs: number): number {
  let sent = 0;
  let at = 0;
  for (;;) {
    at += inputRequestReminderDelayMs(sent);
    if (at > ageMs) return sent;
    sent += 1;
  }
}

/** The origin of a page, or an empty string for anything that isn't http(s). */
export function inputRequestPageOrigin(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

/** What a person reads about a request. Nothing here ever holds a code. */
export type InputRequestView = {
  id: string;
  kind: InputRequestKind;
  status: InputRequestStatus;
  /** The AI Employee's own words, redacted and bounded. */
  title: string;
  /** The AI Employee's own words, redacted and bounded. */
  body: string;
  employee: { id: string; name: string; slug: string; avatarKey: string | null };
  /** Who is asked. Null means the company's owners and admins. */
  assignee: { id: string; name: string } | null;
  /**
   * Read from the browser by the server when the page asked, never from the AI
   * Employee. It is what a person checks before they type a code.
   */
  pageOrigin: string;
  /** The live browser session, for owners and admins, who are the ones who may watch it. */
  browserSessionId: string | null;
  /** The Vault login this code is for, when it has one saved. */
  vaultItemId: string | null;
  /** When the page stops waiting, while `asking`. */
  askingUntil: string | null;
  /** When the request gives up. */
  expiresAt: string;
  createdAt: string;
  /** A code is on its way to the page, and the session hasn't taken it yet. Never the code. */
  answerPending: boolean;
  /** The page asked again after the last code, so that one didn't work. */
  lastCodeRefused: boolean;
  /**
   * This session has read something from outside the company, so these words could
   * have been put in its mouth. A person should check the address themselves.
   */
  tainted: boolean;
  /** The session's browser needs Approval to submit, so answering is an owner's or admin's. */
  adminOnly: boolean;
  /** Where the work is, for a person who wants to look at it. */
  work: {
    kind: "run" | "todo" | "chat" | "other";
    id: string | null;
    label: string;
    link: string | null;
  };
  /** Where to save this login's authenticator, so nobody has to be asked next time. */
  vaultLink: string;
  /** Whether this reader may answer it. */
  canAnswer: boolean;
  /** A Standdown holds this work, so saying you're ready won't start it yet. */
  heldByStanddown: boolean;
  /** Why it ended, in a sentence, once it has. */
  closeReason: string;
};
