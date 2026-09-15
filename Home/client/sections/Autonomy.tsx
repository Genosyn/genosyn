import {
  ARRIVAL,
  GANTT_EVENTS,
  LANE_NAMES,
  LANES,
  RUNS_BEFORE_ARRIVAL,
  type BoardEvent,
} from "@/sections/Board";
import { Gantt } from "@/components/Gantt";
import {
  Band,
  Body,
  Container,
  DEPT_FULL,
  Field,
  Head,
  Row,
  Sheet,
  StateTag,
  TextLink,
  type Dept,
} from "@/sections/Kit";

/** The same overnight work rendered as summary cards, an interactive chart, and a log. */

type LaneEvent = BoardEvent & { owner: string };

/**
 * Lane owner to department. The seven lanes ARE the seven departments — the
 * mapping is the identity, lowercased — but it is guarded rather than cast,
 * because an eighth lane added to Board should fall back to a spineless row
 * instead of asking Tailwind for `bg-dept-legal`.
 */
function deptOf(owner: string): Dept | undefined {
  const key = owner.toLowerCase();
  return key in DEPT_FULL ? (key as Dept) : undefined;
}

const ALL: LaneEvent[] = LANES.flatMap((lane) =>
  lane.events.map((event) => ({ ...event, owner: lane.owner })),
);

/** The eighteen Runs the hero counts, in the order they happened. */
const OVERNIGHT = ALL.filter((event) => event.state === "run" && event.at < ARRIVAL).sort(
  (a, b) => a.at - b.at,
);

/** The Decisions and the Approval — the only things that needed a person. */
const WAITING = ALL.filter((event) => event.state !== "run").sort((a, b) => a.at - b.at);

const DECISIONS = WAITING.filter((event) => event.state === "decision").length;
const APPROVALS = WAITING.filter((event) => event.state === "approval").length;

/** 00:15. The first Run of the night. */
const FIRST = clock(OVERNIGHT[0].at);

/** 09:29 — the last overnight Run ends a minute before anyone signs in. */
const LAST = clock(Math.max(...OVERNIGHT.map((event) => event.at + (event.hours ?? 0.25))));

/** The chart's resting readout line. Both clock times are computed, not typed. */
const SHIFT_SUMMARY = `FIG. 4 · ${RUNS_BEFORE_ARRIVAL} RUNS BETWEEN ${FIRST} AND ${LAST} · 0 MEMBERS SIGNED IN`;

export function Autonomy() {
  return (
    <Band id="autonomy" tone="surface" open="m" close="m">
      <Container>
        <Head
          eyebrow="04 / The shift"
          title="340 dependencies were audited before 03:00."
          lede="Seven departments worked through the same Tuesday night. The wall at the top of the page is one moment of it. This is the whole shift: every Run, the department it belongs to, and how long it took."
          aside={<Field>{`2026-09-01 · ${RUNS_BEFORE_ARRIVAL} RUNS · 0 MEMBERS SIGNED IN`}</Field>}
        />

        <div className="mt-12 grid gap-4 sm:mt-14 sm:grid-cols-3">
          <Count
            label="Runs finished overnight"
            value={String(RUNS_BEFORE_ARRIVAL)}
            note={`Between ${FIRST} and ${LAST}, across seven departments.`}
          />
          <Count
            label="Members signed in"
            value="0"
            note="Nobody was awake for any of it. The first person arrives at 09:30."
          />
          <Count
            label="Waiting for you"
            value={String(WAITING.length)}
            note={`${DECISIONS} Decisions and ${APPROVALS} Approval. Everything else closed itself.`}
            human
          />
        </div>

        {/* The chart gets the full container. It is the evidence, so it gets
            the width.

            Below `md` it is not rendered at all rather than reflowed. A
            timeline that rewraps stops being a timeline, and horizontally
            scrolling a chart on a phone is worse than not having it — the log
            underneath is the same eighteen Runs as text, it stacks natively at
            375px, and it carries the 09:30 rule itself. */}
        <div className="mt-12 hidden sm:mt-14 md:block">
          <p className="sr-only">
            A 24-hour chart of the same Tuesday, one line per department. Every Run before 09:30 is
            listed in the log below it.
          </p>
          {/* No `Plate` around this one. A plate is a mount for a picture — a
              rule, a recessed ground and a numbered caption — and the chart
              brings its own frame and its own readout line, so plating it drew
              two borders and printed "Fig. 4" twice.

              It used to be an `aria-hidden` scroll container with
              `tabIndex={-1}`, because the strip was a picture and the log below
              it was the real text. It is a widget now: focusable bars,
              arrow-key navigation, and a readout that names whatever is
              selected, so hiding it would remove the description rather than
              tidy it away. */}
          <Gantt
            lanes={LANE_NAMES}
            events={GANTT_EVENTS}
            arrival={ARRIVAL}
            arrivalLabel="You sign in"
            ariaLabel="The same Tuesday, drawn as seven departments from midnight to midnight"
            summary={SHIFT_SUMMARY}
          />
        </div>

        <div className="mt-14 sm:mt-16">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <Sheet>Overnight log</Sheet>
            <Field>{`${RUNS_BEFORE_ARRIVAL} RUNS`}</Field>
            <Field>{`${FIRST} TO ${LAST}`}</Field>
          </div>

          <div className="mt-6 space-y-2">
            {OVERNIGHT.map((event) => (
              <LogRow key={`${event.owner}-${event.at}`} event={event} />
            ))}
          </div>

          <Arrival />

          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <Sheet>Waited for you</Sheet>
            <Field>{`${DECISIONS} ${plural("DECISION", DECISIONS)} · ${APPROVALS} ${plural(
              "APPROVAL",
              APPROVALS,
            )}`}</Field>
          </div>

          <div className="mt-6 space-y-2">
            {WAITING.map((event) => (
              <WaitingRow key={`${event.owner}-${event.at}`} event={event} />
            ))}
          </div>

          <div className="mt-10">
            <TextLink href="/docs/routines">Read how a Routine becomes a Run</TextLink>
          </div>
        </div>
      </Container>
    </Band>
  );
}

/** The human-facing count gets the same indigo emphasis as an active app surface. */
function Count({
  label,
  value,
  note,
  human = false,
}: {
  label: string;
  value: string;
  note: string;
  human?: boolean;
}) {
  return (
    <div
      className={`flex flex-col justify-between gap-8 rounded-xl border p-5 shadow-sm ${
        human ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white"
      }`}
    >
      <span
        className={`text-xs font-semibold ${human ? "text-indigo-700" : "text-slate-500"}`}
      >
        {label}
      </span>
      <div>
        <div
          className={`text-[clamp(2.75rem,5vw,4rem)] font-semibold leading-none tracking-tight ${
            human ? "text-indigo-950" : "text-slate-950"
          }`}
        >
          {value}
        </div>
        <p
          className={`mt-3 max-w-[26ch] text-[13px] leading-snug ${
            human ? "text-indigo-900/80" : "text-slate-600"
          }`}
        >
          {note}
        </p>
      </div>
    </div>
  );
}

/** One Run in the text equivalent of the chart. */
function LogRow({ event }: { event: LaneEvent }) {
  return (
    <Row dept={deptOf(event.owner)}>
      <Field className="w-[3.25rem] shrink-0">{clock(event.at)}</Field>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-5 gap-y-1.5">
        <Body className="min-w-[13rem] flex-1">{event.label}</Body>
        <Sheet className="shrink-0">{event.owner}</Sheet>
        <Field className="shrink-0">{`${minutes(event.hours ?? 0.25)} MIN`}</Field>
      </div>
    </Row>
  );
}

/** A Decision or Approval, kept distinct in both copy and `StateTag`. */
function WaitingRow({ event }: { event: LaneEvent }) {
  return (
    <Row dept={deptOf(event.owner)}>
      <Field className="w-[3.25rem] shrink-0">{clock(event.at)}</Field>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-5 gap-y-2">
        <Body className="min-w-[13rem] flex-1">{event.label}</Body>
        <StateTag state={event.state} className="shrink-0">
          {event.state === "decision" ? "Decision" : "Approval"}
        </StateTag>
        <Sheet className="shrink-0">{event.owner}</Sheet>
      </div>
    </Row>
  );
}

/** The boundary between overnight work and the first Member signing in. */
function Arrival() {
  return (
    <div className="my-9 flex items-center gap-3">
      <span className="shrink-0 rounded-full bg-indigo-600 px-2.5 py-1 font-mono text-[10px] font-semibold leading-none text-white">
        09:30 YOU SIGN IN
      </span>
      <span aria-hidden className="h-px flex-1 bg-indigo-200" />
    </div>
  );
}

/* -------------------------------------------------------------------------
   Formatting.

   `clock` is duplicated from Board rather than imported: Board keeps it
   private, and widening its public surface to share a four-line pure function
   would make a data module into a utility one. The event data is imported,
   which is the part that can drift.
------------------------------------------------------------------------- */

function clock(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutes(hours: number): number {
  return Math.round(hours * 60);
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}S`;
}
