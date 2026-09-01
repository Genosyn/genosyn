import { Mark } from "@/components/Marks";
import { Field, Rule, Sheet } from "@/sections/Kit";

/**
 * The 24-hour board — one Tuesday at a company running on Genosyn.
 *
 * This is the centrepiece of the site and it replaces the hero screenshot.
 * The reasoning: the only claim Genosyn makes that cannot be faked by a
 * competitor's landing page is a timestamp. Work happened at 04:05 and nobody
 * was awake. The previous site had that fact and wrote it as a caption under a
 * picture, then spent nine bands asserting it in prose. Here the evidence is
 * the page and the prose is the caption.
 *
 * How to read it, which is also how it is built:
 *
 *   - Left to right is midnight to midnight. A bar's LEFT EDGE is when a Run
 *     started; its WIDTH is how long the Run took. So 04:05's forty-minute
 *     reconciliation is visibly forty minutes, and the 21:15 sweep is visibly
 *     longer. Nothing here is a decorative rectangle.
 *   - The amber rule at 39.583% is 09:30 — when a person signs in. Everything
 *     left of it happened without one. The three marks to the right of it are
 *     the only things waiting.
 *   - That ratio, machine-time to your-time, is the entire pitch, drawn.
 *
 * The one animation on the site lives here and it is the argument rather than
 * decoration: bars draw left to right, staggered, so the night fills in and
 * then you arrive. It is disabled wholesale under `prefers-reduced-motion`.
 *
 * On the honesty of the data: this is a sample company, and the board says so
 * in its own fascia in the same mono as every other field rather than
 * apologising for it in a caption underneath. A board that claims to display
 * state while displaying fiction is worse than prose that claims nothing, so
 * the disclosure is part of the instrument.
 */

export type BoardEvent = {
  /** Start, in hours past midnight. */
  at: number;
  /** Duration in hours. Decisions and Approvals are moments, not durations. */
  hours?: number;
  label: string;
  state: "run" | "decision" | "approval";
};

type Lane = {
  owner: string;
  events: BoardEvent[];
};

/** The line a person arrives on: 09:30 of 24 hours = 39.583%. */
export const ARRIVAL = 9.5;

export const LANES: Lane[] = [
  {
    owner: "Finance",
    events: [
      { at: 0.25, hours: 0.5, label: "Close yesterday's ledger", state: "run" },
      { at: 4.08, hours: 0.67, label: "Reconcile 42 Stripe payments", state: "run" },
      { at: 7, hours: 0.5, label: "Draft the VAT return", state: "run" },
      { at: 10.67, label: "Write off a £42 discrepancy, or chase it?", state: "decision" },
    ],
  },
  {
    owner: "Repositories",
    events: [
      { at: 1.5, hours: 1.2, label: "Audit 340 dependencies", state: "run" },
      { at: 5.17, hours: 0.75, label: "Open a fix for the flaky checkout test", state: "run" },
      { at: 8.25, hours: 0.5, label: "Review 3 pull requests", state: "run" },
      { at: 14.08, hours: 0.5, label: "Rerun the release Check", state: "run" },
    ],
  },
  {
    owner: "Marketing",
    events: [
      { at: 2.33, hours: 0.9, label: "Draft the launch digest", state: "run" },
      { at: 6.5, hours: 0.6, label: "Schedule Thursday's posts", state: "run" },
      { at: 13.17, label: "Publish the pricing post", state: "approval" },
      { at: 16, hours: 0.5, label: "Cut the weekly report", state: "run" },
    ],
  },
  {
    owner: "Workspace",
    events: [
      { at: 3, hours: 0.4, label: "Summarise 14 threads", state: "run" },
      { at: 8.83, hours: 0.5, label: "Assemble the 09:00 TLDR", state: "run" },
      { at: 15.33, hours: 0.4, label: "Answer a question about Q3 churn", state: "run" },
    ],
  },
  {
    owner: "Email",
    events: [
      { at: 0.83, hours: 0.5, label: "Triage the overnight inbox", state: "run" },
      { at: 5.75, hours: 0.7, label: "Answer 31 support emails", state: "run" },
      { at: 9.08, hours: 0.4, label: "Hand 2 threads to a Member", state: "run" },
      { at: 12.5, hours: 0.6, label: "Chase 4 unanswered replies", state: "run" },
    ],
  },
  {
    owner: "Revenue",
    events: [
      { at: 2.83, hours: 0.8, label: "Enrich 118 new Contacts", state: "run" },
      { at: 6.08, hours: 0.9, label: "Send the Tuesday sequence", state: "run" },
      { at: 8.67, hours: 0.4, label: "Move 6 Deals a stage", state: "run" },
      { at: 11, label: "Which reply goes to Northstar?", state: "decision" },
      { at: 17.5, hours: 0.4, label: "Log 3 discovery calls", state: "run" },
    ],
  },
  {
    owner: "Operations",
    events: [
      { at: 3.67, hours: 0.6, label: "Back the volume up to S3", state: "run" },
      { at: 7.75, hours: 0.35, label: "Run 22 health probes", state: "run" },
      { at: 21.25, hours: 0.75, label: "Sweep and compact the audit log", state: "run" },
    ],
  },
];

const ALL = LANES.flatMap((lane) => lane.events.map((event) => ({ ...event, owner: lane.owner })));

/** Eighteen. The headline is not a round number because it is a count. */
export const RUNS_BEFORE_ARRIVAL = ALL.filter(
  (event) => event.state === "run" && event.at < ARRIVAL,
).length;

export const DECISIONS_WAITING = ALL.filter((event) => event.state === "decision").length;
export const APPROVALS_WAITING = ALL.filter((event) => event.state === "approval").length;

const pct = (hours: number) => `${(hours / 24) * 100}%`;

export function Board() {
  return (
    <div>
      <BoardFascia />

      {/* Desktop: the chart. It keeps a fixed minimum width and scrolls inside
          its own container rather than reflowing — a timeline that rewraps
          stops being a timeline. */}
      <div className="hidden overflow-x-auto border-x border-b border-paper-400 bg-paper-50 md:block">
        <Chart />
      </div>

      {/* Mobile: a different true projection, not a media query on the chart.
          Horizontal-scrolling the most important element on the site would be
          a real usability failure, so below `md` the same data is drawn as the
          run log it also is: a time column and a line column, which stacks
          natively at 375px. */}
      <div className="border-x border-b border-paper-400 bg-paper-50 md:hidden">
        <RunLog />
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Field>{`${RUNS_BEFORE_ARRIVAL} RUNS BEFORE 09:30`}</Field>
        <Field>0 MEMBERS SIGNED IN</Field>
        <Field>{`${DECISIONS_WAITING} DECISIONS · ${APPROVALS_WAITING} APPROVAL WAITING`}</Field>
      </div>
    </div>
  );
}

/** The board's own header. `SAMPLE COMPANY` is a field, not an apology. */
function BoardFascia() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-paper-400 bg-zinc-950 px-4 py-2.5">
      <Sheet className="!text-paper-50">Tuesday</Sheet>
      <span className="t-data text-[11px] leading-4 text-zinc-300">00:00–24:00</span>
      <span className="t-data text-[11px] leading-4 text-zinc-400">SAMPLE COMPANY</span>
      <span className="ml-auto hidden items-center gap-4 sm:flex">
        <LegendItem state="run">Run</LegendItem>
        <LegendItem state="decision">Decision</LegendItem>
        <LegendItem state="approval">Approval</LegendItem>
      </span>
    </div>
  );
}

function LegendItem({
  state,
  children,
}: {
  state: "run" | "decision" | "approval";
  children: string;
}) {
  const human = state !== "run";
  return (
    <span
      className={`t-cond inline-flex items-center gap-1.5 text-[10px] uppercase tracking-field ${
        human ? "text-signal-500" : "text-zinc-400"
      }`}
    >
      <Mark state={state} className="h-2.5 w-2.5" />
      {children}
    </span>
  );
}

function Chart() {
  return (
    <div className="min-w-[58rem] p-5">
      <div className="grid grid-cols-[minmax(0,1fr)_8.5rem]">
        <div className="relative pt-7">
          {/* One element, one gradient: the 24 hour columns. They start below
              the flag row and stop above the hour scale. */}
          <div aria-hidden className="hours absolute top-7 right-0 bottom-6 left-0" />

          {/* The quarter marks are drawn stronger, so the eye has something to
              measure against without turning the chart into graph paper. */}
          {[6, 12, 18].map((hour) => (
            <div
              key={hour}
              aria-hidden
              className="absolute top-7 bottom-6 w-px bg-paper-400"
              style={{ left: pct(hour) }}
            />
          ))}

          {LANES.map((lane) => (
            <div key={lane.owner} className="relative h-[2.375rem] border-b border-paper-300">
              {lane.events.map((event) => (
                <Bar key={`${lane.owner}-${event.at}`} event={event} />
              ))}
            </div>
          ))}

          <Arrival />
          <HourScale />
        </div>

        {/* The owner column carries the same 1.75rem top offset as the chart,
            so lane labels line up with their lanes rather than with the flag
            row above them. */}
        <div className="pt-7">
          {LANES.map((lane) => (
            <div
              key={lane.owner}
              className="flex h-[2.375rem] items-center border-b border-paper-300 pl-4"
            >
              <Sheet className="!text-[10px]">{lane.owner}</Sheet>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One event.
 *
 * **A Run carries no label, and that is the design rather than an omission.**
 *
 * The first attempt hung each Run's description beside its bar, which fails
 * twice over: a forty-minute Run is about 28px wide so the text cannot sit
 * inside it, and once the text hangs outside, adjacent Runs in the same lane
 * overlap each other into an unreadable smear. But the deeper problem is that
 * nobody reads twenty-six labels on a chart. A reader takes one thing from
 * this picture — the night is full and the morning has three items in it —
 * and every label competing for attention makes that harder to see, not
 * easier.
 *
 * So the only events on the board carrying words are the Decisions and the
 * Approval. Three labels, on the three things that need a person, in the one
 * colour the site owns. The argument draws itself: everything unlabelled ran
 * without you, and everything you can read is waiting for you. The individual
 * Runs keep their detail in a `title` for a pointer, and the whole log is
 * spelled out hour by hour in the band below.
 */
function Bar({ event }: { event: BoardEvent }) {
  const human = event.state !== "run";

  // Moments have no duration, so they are drawn as a mark rather than a bar.
  if (human) {
    return (
      <div
        className="absolute top-1/2 flex -translate-y-1/2 items-center gap-2"
        style={{ left: pct(event.at) }}
      >
        <span className="strip-draw flex h-[1.375rem] shrink-0 items-center gap-1.5 bg-signal-500 px-1.5 text-zinc-950">
          <Mark state={event.state} className="h-2.5 w-2.5" />
          <span className="t-data whitespace-nowrap text-[10px] leading-none">
            {clock(event.at)}
          </span>
        </span>
        <span className="t-body whitespace-nowrap text-[12px] leading-none text-zinc-800">
          {event.label}
        </span>
      </div>
    );
  }

  return (
    <div
      className="absolute top-1/2 h-[1.375rem] min-w-[3px] -translate-y-1/2"
      style={{ left: pct(event.at), width: pct(event.hours ?? 0.25) }}
      title={`${clock(event.at)} · ${event.label}`}
    >
      <div className="strip-draw h-full border border-paper-400 border-l-[3px] border-l-zinc-950 bg-paper-50" />
    </div>
  );
}

/**
 * The 09:30 rule and its flag — the only colour in the hero.
 *
 * The flag sits in a reserved row above the lanes rather than on top of the
 * first one. Anchored to the lane stack it landed squarely on the Finance
 * Decision at 10:40 and the two amber elements fought each other, which is a
 * bad outcome for the two things the whole picture is pointing at.
 */
function Arrival() {
  return (
    <>
      <span
        aria-hidden
        className="arrive-in absolute top-0 flex h-[1.375rem] items-center whitespace-nowrap bg-signal-500 px-2"
        style={{ left: pct(ARRIVAL) }}
      >
        <span className="t-data text-[10px] leading-none text-zinc-950">09:30 YOU SIGN IN</span>
      </span>
      <span
        aria-hidden
        className="arrive-in absolute top-7 bottom-6 w-0.5 bg-signal-500"
        style={{ left: pct(ARRIVAL) }}
      />
    </>
  );
}

function HourScale() {
  return (
    <div aria-hidden className="relative h-6">
      {[0, 6, 12, 18].map((hour) => (
        <span
          key={hour}
          className="t-data absolute top-1.5 text-[10px] leading-none text-zinc-600"
          style={{ left: pct(hour) }}
        >
          {clock(hour)}
        </span>
      ))}
      <span className="t-data absolute top-1.5 right-0 text-[10px] leading-none text-zinc-600">
        24:00
      </span>
    </div>
  );
}

/**
 * The same Tuesday as a run log — the mobile projection.
 *
 * Same data, no chart, stacks natively at 375px. The 09:30 line survives as a
 * horizontal amber rule across the list, with the things waiting below it.
 */
function RunLog() {
  const sorted = [...ALL].sort((a, b) => a.at - b.at);
  const before = sorted.filter((event) => event.at < ARRIVAL);
  const after = sorted.filter((event) => event.at >= ARRIVAL);

  return (
    <div className="px-4 py-3">
      {before.map((event) => (
        <LogRow key={`${event.owner}-${event.at}`} event={event} />
      ))}

      <div className="my-2 flex items-center gap-3">
        <span className="t-data shrink-0 bg-signal-500 px-1.5 py-1 text-[10px] leading-none text-zinc-950">
          09:30 YOU SIGN IN
        </span>
        <span aria-hidden className="h-0.5 flex-1 bg-signal-500" />
      </div>

      {after.map((event) => (
        <LogRow key={`${event.owner}-${event.at}`} event={event} />
      ))}
    </div>
  );
}

/**
 * One line of the run log.
 *
 * The human rows carry the mark on an amber FILL rather than drawing the mark
 * in amber. That is the palette's rule and it is an accessibility rule: on a
 * light ground `signal` is 1.65:1 as a foreground, and even the darker
 * `signal-600` only reaches 2.44:1 on the board's raised surface, under the
 * 3:1 that WCAG 1.4.11 requires of a graphic carrying meaning. Drawing the
 * mark in near-black on an amber tile gives 10.31:1 and keeps amber doing the
 * one job it has on this site: marking the rows that need a person.
 */
function LogRow({ event }: { event: BoardEvent & { owner: string } }) {
  const human = event.state !== "run";
  return (
    <div className="flex items-baseline gap-3 border-b border-paper-300 py-2 last:border-b-0">
      <span className="t-data w-11 shrink-0 text-[10px] leading-4 text-zinc-600">
        {clock(event.at)}
      </span>
      <Mark
        state={event.state}
        className={`mt-0.5 h-4 w-4 shrink-0 p-0.5 ${
          human ? "bg-signal-500 text-zinc-950" : "text-zinc-700"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="t-body block text-[13px] leading-5 text-zinc-800">{event.label}</span>
        <Sheet className="!text-[10px]">{event.owner}</Sheet>
      </span>
    </div>
  );
}

function clock(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export { Rule };
