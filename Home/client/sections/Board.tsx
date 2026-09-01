import { Gantt, type GanttEvent } from "@/components/Gantt";
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
  /**
   * The one Run the hero names. Exactly one event carries this, so the
   * sentence at the top of the page is built from the chart underneath it and
   * cannot drift away from it.
   */
  lead?: true;
  /** The hero's phrasing of what this Run produced. */
  claim?: string;
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
      { at: 0.25, hours: 0.5, label: "Overnight journal entries posted", state: "run" },
      {
        at: 4.08,
        hours: 0.67,
        label: "42 Stripe payments reconciled, 3 exceptions queued",
        state: "run",
        lead: true,
        claim: "42 Stripe payments were reconciled",
      },
      { at: 7, hours: 0.5, label: "Yesterday's ledger, closed and balanced", state: "run" },
      { at: 10.67, label: "Write off a £42 discrepancy, or chase it?", state: "decision" },
    ],
  },
  {
    owner: "Repositories",
    events: [
      { at: 1.5, hours: 1.2, label: "340 dependencies audited, 14 brought current", state: "run" },
      { at: 5.17, hours: 0.75, label: "A fix open on the flaky checkout test", state: "run" },
      { at: 8.25, hours: 0.5, label: "3 pull requests reviewed", state: "run" },
      { at: 14.08, hours: 0.5, label: "The release Check, green on a rerun", state: "run" },
    ],
  },
  {
    owner: "Marketing",
    events: [
      { at: 2.33, hours: 0.9, label: "The launch digest, drafted", state: "run" },
      { at: 6.5, hours: 0.6, label: "Thursday's posts, scheduled", state: "run" },
      { at: 13.17, label: "Publish the pricing post", state: "approval" },
      { at: 16, hours: 0.5, label: "The weekly report, cut and filed", state: "run" },
    ],
  },
  {
    owner: "Workspace",
    events: [
      { at: 3, hours: 0.4, label: "14 threads summarised into one page", state: "run" },
      { at: 8.83, hours: 0.5, label: "The 09:00 TLDR, assembled", state: "run" },
      { at: 15.33, hours: 0.4, label: "The Q3 churn question answered", state: "run" },
    ],
  },
  {
    owner: "Email",
    events: [
      { at: 0.83, hours: 0.5, label: "The overnight inbox, triaged", state: "run" },
      { at: 5.75, hours: 0.7, label: "31 support emails answered, 6 min median", state: "run" },
      { at: 9.08, hours: 0.4, label: "2 threads handed to a Member", state: "run" },
      { at: 12.5, hours: 0.6, label: "4 unanswered replies chased", state: "run" },
    ],
  },
  {
    owner: "Revenue",
    events: [
      { at: 2.83, hours: 0.8, label: "Domains proposed for 6 new Accounts", state: "run" },
      { at: 6.08, hours: 0.9, label: "The Tuesday Sequence, sent", state: "run" },
      { at: 8.67, hours: 0.4, label: "6 Deals moved a Stage", state: "run" },
      { at: 11, label: "Which reply goes to Northstar?", state: "decision" },
      { at: 17.5, hours: 0.4, label: "3 discovery calls logged as Activities", state: "run" },
    ],
  },
  {
    owner: "Operations",
    events: [
      { at: 3.67, hours: 0.6, label: "Last night's archive, mirrored to SFTP", state: "run" },
      { at: 7.75, hours: 0.35, label: "22 health probes, all green", state: "run" },
      { at: 21.25, hours: 0.75, label: "The audit log, swept and compacted", state: "run" },
    ],
  },
];

const ALL = LANES.flatMap((lane) => lane.events.map((event) => ({ ...event, owner: lane.owner })));

/** Lane names in board order, and the events flattened for the shared chart. */
export const LANE_NAMES = LANES.map((lane) => lane.owner);

export const GANTT_EVENTS: GanttEvent[] = LANES.flatMap((lane) =>
  lane.events.map((event) => ({
    lane: lane.owner,
    at: event.at,
    hours: event.hours,
    label: event.label,
    state: event.state,
  })),
);

/** Eighteen. The headline is not a round number because it is a count. */
export const RUNS_BEFORE_ARRIVAL = ALL.filter(
  (event) => event.state === "run" && event.at < ARRIVAL,
).length;

export const DECISIONS_WAITING = ALL.filter((event) => event.state === "decision").length;

/**
 * The lead artefact, and the clock time it was finished by.
 *
 * The hero used to count how many times the scheduler fired, which told a
 * reader the machine was busy and nothing about whether anything now exists.
 * It names one finished thing instead, and everything else on the night is
 * carried by the lede and the readout below it. One checkable claim is worth
 * more than a total, because a reader can picture 42 reconciled payments and
 * cannot picture eighteen Runs.
 */
const LEAD = ALL.find((event) => event.lead && event.claim);

export const LEAD_CLAIM = LEAD?.claim ?? "Work finished overnight";
export const LEAD_DONE_BY = clock((LEAD?.at ?? ARRIVAL) + (LEAD?.hours ?? 0));
/** Everything else that finished overnight, for the lede's second sentence. */
export const OTHERS_BEFORE_ARRIVAL = RUNS_BEFORE_ARRIVAL - 1;
export const APPROVALS_WAITING = ALL.filter((event) => event.state === "approval").length;

/**
 * The readout's resting line.
 *
 * It leads with what the night produced rather than with how many times the
 * scheduler fired: a count of Runs tells a reader the machine was busy, which
 * is not the same as telling them anything now exists.
 */
const SUMMARY = `FIG. 1 · 42 PAYMENTS RECONCILED · ${RUNS_BEFORE_ARRIVAL} FINISHED BY 09:30 · 0 MEMBERS SIGNED IN · ${DECISIONS_WAITING} DECISIONS AND ${APPROVALS_WAITING} APPROVAL WAITING`;

export function Board() {
  return (
    <div>
      <BoardFascia />

      {/* Desktop: the chart. It keeps a fixed minimum width and scrolls inside
          its own container rather than reflowing — a timeline that rewraps
          stops being a timeline. */}
      <div className="hidden lg:block">
        <Gantt
          lanes={LANE_NAMES}
          events={GANTT_EVENTS}
          arrival={ARRIVAL}
          nightUntil={ARRIVAL}
          arrivalLabel="You sign in"
          ariaLabel="One Tuesday at a sample company, midnight to midnight"
          summary={SUMMARY}
        />
      </div>

      {/* Below `lg`, a different true projection rather than a media query on
          the chart. The switch is at `lg` and not `md` because the plot needs
          about 864px: at `md` the container is 752px, so the chart was
          scrolling sideways across the whole tablet range, which is precisely
          the failure this split exists to avoid. */}
      <div className="border-x border-b border-paper-400 bg-paper-50 lg:hidden">
        <RunLog />
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
      <span className="flex w-full items-center gap-4 sm:ml-auto sm:w-auto">
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
  const firstAt = before[0]?.at ?? 0;
  const lastEnd = Math.max(...before.map((e) => e.at + (e.hours ?? 0)));

  return (
    <div className="px-4 py-3">
      {/* The overnight half is summarised rather than listed. Printing all
          eighteen rows here made the hero 2.2 screens tall on a phone and then
          Autonomy printed the same eighteen again a screen later. The shape is
          the useful thing at this size; the log lives in the night band. */}
      <div className="border-b border-paper-300 pb-3">
        <Field>{`${before.length} FINISHED · ${clock(firstAt)}–${clock(lastEnd)}`}</Field>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {LANE_NAMES.map((lane) => (
            <Sheet key={lane} className="!text-[10px]">
              {lane}
            </Sheet>
          ))}
        </div>
      </div>

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
