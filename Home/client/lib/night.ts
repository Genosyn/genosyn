import type { Dept } from "@/sections/Kit";

/**
 * One Tuesday at Northstar Labs, a sample company running on Genosyn.
 *
 * The landing page tells this night three times — the hero's live console,
 * the whole-shift chart, and the 09:31 dashboard — and all three read this
 * module, so a Run cannot finish at 04:45 in one place and 04:50 in another.
 *
 * Left to right is midnight to midnight: `at` is when a Run started, in hours
 * past midnight, and `hours` is how long it took. Decisions and Approvals are
 * moments, not durations. The sample is illustrative, not an exported log, and
 * every surface that draws it says so.
 */

export type NightState = "run" | "decision" | "approval";

export type NightEvent = {
  at: number;
  hours?: number;
  label: string;
  state: NightState;
};

export type Lane = {
  dept: Dept;
  /** The AI Employee who owns this department's work. */
  person: string;
  initials: string;
  role: string;
  events: NightEvent[];
};

/** 09:30 — when the first Member signs in. */
export const ARRIVAL = 9.5;

export const COMPANY = "Northstar Labs";

export const LANES: Lane[] = [
  {
    dept: "finance",
    person: "Mira",
    initials: "MI",
    role: "AI Bookkeeper",
    events: [
      { at: 0.25, hours: 0.5, label: "Overnight journal entries posted", state: "run" },
      { at: 4.08, hours: 0.67, label: "42 Stripe payments reconciled, 3 exceptions queued", state: "run" },
      { at: 7, hours: 0.5, label: "Yesterday's ledger, closed and balanced", state: "run" },
      { at: 10.67, label: "Write off a £42 discrepancy, or chase it?", state: "decision" },
    ],
  },
  {
    dept: "repositories",
    person: "Sam",
    initials: "SA",
    role: "AI Engineer",
    events: [
      { at: 1.5, hours: 1.2, label: "340 dependencies audited, 14 brought current", state: "run" },
      { at: 5.17, hours: 0.75, label: "A fix opened for the flaky checkout test", state: "run" },
      { at: 8.25, hours: 0.5, label: "3 pull requests reviewed", state: "run" },
      { at: 14.08, hours: 0.5, label: "The release Check, green on a rerun", state: "run" },
    ],
  },
  {
    dept: "marketing",
    person: "Alex",
    initials: "AL",
    role: "AI Marketer",
    events: [
      { at: 2.33, hours: 0.9, label: "The launch digest, drafted", state: "run" },
      { at: 6.5, hours: 0.6, label: "Thursday's posts, scheduled", state: "run" },
      { at: 13.17, label: "Publish the pricing post", state: "approval" },
      { at: 16, hours: 0.5, label: "The weekly report, cut and filed", state: "run" },
    ],
  },
  {
    dept: "workspace",
    person: "Nova",
    initials: "NV",
    role: "AI Analyst",
    events: [
      { at: 3, hours: 0.4, label: "14 threads summarised into one page", state: "run" },
      { at: 8.83, hours: 0.5, label: "The 09:00 TLDR, assembled", state: "run" },
      { at: 15.33, hours: 0.4, label: "The Q3 churn question answered", state: "run" },
    ],
  },
  {
    dept: "email",
    person: "Pax",
    initials: "PX",
    role: "AI Support Rep",
    events: [
      { at: 0.83, hours: 0.5, label: "The overnight inbox, triaged", state: "run" },
      { at: 5.75, hours: 0.7, label: "31 support emails answered, 6 min median", state: "run" },
      { at: 9.08, hours: 0.35, label: "2 threads handed to a Member", state: "run" },
      { at: 12.5, hours: 0.6, label: "4 unanswered replies chased", state: "run" },
    ],
  },
  {
    dept: "revenue",
    person: "Robin",
    initials: "RO",
    role: "AI SDR",
    events: [
      { at: 2.83, hours: 0.8, label: "Domains proposed for 6 new Accounts", state: "run" },
      { at: 6.08, hours: 0.9, label: "The Tuesday Sequence, sent", state: "run" },
      { at: 8.67, hours: 0.4, label: "6 Deals moved a Stage", state: "run" },
      { at: 11, label: "Which reply goes to Northstar?", state: "decision" },
      { at: 17.5, hours: 0.4, label: "3 discovery calls logged as Activities", state: "run" },
    ],
  },
  {
    dept: "operations",
    person: "Avery",
    initials: "AV",
    role: "AI Executive Assistant",
    events: [
      { at: 3.67, hours: 0.6, label: "Last night's archive, mirrored to SFTP", state: "run" },
      { at: 7.75, hours: 0.35, label: "22 health probes, all green", state: "run" },
      { at: 21.25, hours: 0.75, label: "The audit log, swept and compacted", state: "run" },
    ],
  },
];

export type FlatEvent = NightEvent & Omit<Lane, "events">;

export const ALL_EVENTS: FlatEvent[] = LANES.flatMap(({ events, ...lane }) =>
  events.map((event) => ({ ...event, ...lane })),
).sort((a, b) => a.at - b.at);

/** Every Run that started before anyone signed in, in the order they started. */
export const OVERNIGHT: FlatEvent[] = ALL_EVENTS.filter(
  (event) => event.state === "run" && event.at < ARRIVAL,
);

/** The only things that needed a person. */
export const WAITING: FlatEvent[] = ALL_EVENTS.filter((event) => event.state !== "run");

export const DECISIONS_WAITING = WAITING.filter((event) => event.state === "decision").length;
export const APPROVALS_WAITING = WAITING.filter((event) => event.state === "approval").length;

export const FIRST_RUN = OVERNIGHT[0].at;
export const LAST_OVERNIGHT_END = Math.max(
  ...OVERNIGHT.map((event) => event.at + (event.hours ?? 0.25)),
);

export function runMinutes(event: NightEvent): number {
  return Math.round((event.hours ?? 0.25) * 60);
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/** Small counts read better as words in a headline. */
export function spell(count: number): string {
  return WORDS[count] ?? String(count);
}
