import { Mark } from "@/components/Marks";
import { ARRIVAL, LANES, RUNS_BEFORE_ARRIVAL, type BoardEvent } from "@/sections/Board";
import {
  Band,
  Body,
  Container,
  Field,
  Heading,
  Lede,
  Plate,
  Rail,
  Row,
  Sheet,
  StateTag,
  TextLink,
} from "@/sections/Kit";

/**
 * Sheet 04 — the night shift, and the one dark band on the landing page.
 *
 * The hero draws the whole Tuesday and deliberately leaves every Run
 * unlabelled: twenty-six captions on one chart is not evidence, it is noise.
 * That decision has to be paid for somewhere, and this is where. Below the
 * strip the overnight Runs are printed out one per row, with the clock time
 * they started, how long they took, and which lane they belong to. It is the
 * most concrete thing on the page and it is the reason the band exists.
 *
 * Every number here is imported from `@/sections/Board`. The previous version
 * kept its own seven-event `DAY` array with different times, different people
 * and a different arrival marker from the timeline in the hero, so the page
 * quietly contradicted itself twice. One event list, two projections.
 *
 * What was dropped, and why:
 *
 *   - The three stat panels (18 / 0 / 3 at 3rem in white, emerald and amber).
 *     They restated three facts the strip already draws, in three hues the
 *     palette no longer has. The same three facts now sit in the rail's mono
 *     fields, which is where a count belongs.
 *   - The four-across "autonomy ladder" of pastel icon tiles. Four abstractions
 *     ("You ask, it does", "You write it down once") illustrated with four
 *     lucide glyphs in four ring colours. It did not survive the test of
 *     showing the artefact: nothing in it was a Routine, a Run or a time. The
 *     rules-separated `Row` stack it could have become is spent on the
 *     overnight log instead, which is the same argument made from data.
 *   - `aurora-night` and `night-grid`, both deleted from index.css.
 */

type LaneEvent = BoardEvent & { owner: string };

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

export function Autonomy() {
  return (
    <Band id="autonomy" tone="night" pad="l">
      <Container>
        <Rail
          night
          sheet="04 / The night shift"
          fields={["2026-09-01", `${RUNS_BEFORE_ARRIVAL} RUNS`, "0 MEMBERS"]}
        >
          <Heading as="h2" night className="max-w-[20ch]">
            {`The night shift ran from ${FIRST} to ${LAST}.`}
          </Heading>

          <Lede night className="mt-7">
            Seven lanes worked through the same Tuesday night. The board at the top of the page
            draws those Runs without labels. This is the log instead: every one of them, with its
            lane and how long it took.
          </Lede>
        </Rail>

        {/* The strip breaks out of the rail to the full container, the way the
            hero's board does. It is the evidence, so it gets the width.

            Below `md` it is not rendered at all rather than reflowed. A
            timeline that rewraps stops being a timeline, and horizontally
            scrolling a chart on a phone is worse than not having it — the log
            underneath is the same eighteen Runs as text, it stacks natively at
            375px, and it carries the 09:30 rule itself. */}
        <div className="mt-14 hidden sm:mt-16 md:block">
          <p className="sr-only">
            A 24-hour strip of the same Tuesday, one line per lane. Every Run before 09:30 is
            listed in the log below it.
          </p>
          <Plate
            night
            figure="Fig. 4"
            caption="Seven lanes, one Tuesday. Everything left of the amber rule ran unattended."
          >
            {/* `tabIndex={-1}` is load-bearing, not decoration. Chrome puts a
                scroll container with no focusable children into the sequential
                tab order so it can be scrolled from the keyboard, and an
                `aria-hidden` element in the tab order is a 4.1.2 failure: the
                user tabs into something no screen reader will name. Marking it
                programmatically-focusable-only resolves that, and costs
                nothing here because the strip carries no information the log
                below it does not print as text. */}
            <div aria-hidden tabIndex={-1} className="overflow-x-auto">
              <Strip />
            </div>
          </Plate>
        </div>

        {/* The rail resumes so the spine picks up again under the strip. No
            sheet number: a band gets one, and it was spent at the top. */}
        <Rail night className="mt-16 sm:mt-20">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <Sheet night>Overnight log</Sheet>
            <Field night>{`${RUNS_BEFORE_ARRIVAL} RUNS`}</Field>
            <Field night>{`${FIRST} TO ${LAST}`}</Field>
          </div>

          <div className="mt-6">
            {OVERNIGHT.map((event) => (
              <LogRow key={`${event.owner}-${event.at}`} event={event} />
            ))}
          </div>

          <Arrival />

          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <Sheet night>Waited for you</Sheet>
            <Field night>{`${DECISIONS} ${plural("DECISION", DECISIONS)} · ${APPROVALS} ${plural(
              "APPROVAL",
              APPROVALS,
            )}`}</Field>
          </div>

          <div className="mt-6">
            {WAITING.map((event) => (
              <WaitingRow key={`${event.owner}-${event.at}`} event={event} />
            ))}
          </div>

          <div className="mt-10">
            <TextLink href="/docs/routines" night>
              Read how a Routine becomes a Run
            </TextLink>
          </div>
        </Rail>
      </Container>
    </Band>
  );
}

/**
 * One Run in the log.
 *
 * The lane and the duration sit on the same flex line as the label and wrap
 * under it when there is no room. The alternative — hiding them below `sm` —
 * drops the two facts that make a row worth printing, and the first thing a
 * reader wants after "04:05" is "for how long".
 */
function LogRow({ event }: { event: LaneEvent }) {
  return (
    <Row night>
      <Field night className="w-[3.25rem] shrink-0">
        {clock(event.at)}
      </Field>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-5 gap-y-1.5">
        <Body night className="min-w-[13rem] flex-1">
          {event.label}
        </Body>
        <Sheet night className="shrink-0">
          {event.owner}
        </Sheet>
        <Field night className="shrink-0">
          {`${minutes(event.hours ?? 0.25)} MIN`}
        </Field>
      </div>
    </Row>
  );
}

/**
 * A Decision or the Approval.
 *
 * The mark carries the distinction AGENTS.md §3 insists on and every other
 * product collapses: a Decision is open on its right edge because the employee
 * stopped and asked, an Approval is barred across the middle because the
 * system interposed on something the employee had already started. The old
 * version drew all three with the same shield glyph and called the lot
 * "Escalated", which named neither.
 */
function WaitingRow({ event }: { event: LaneEvent }) {
  return (
    <Row night>
      <Field night className="w-[3.25rem] shrink-0">
        {clock(event.at)}
      </Field>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-5 gap-y-2">
        <Body night className="min-w-[13rem] flex-1">
          {event.label}
        </Body>
        <StateTag night state={event.state} className="shrink-0">
          {event.state === "decision" ? "Decision" : "Approval"}
        </StateTag>
        <Sheet night className="shrink-0">
          {event.owner}
        </Sheet>
      </div>
    </Row>
  );
}

/**
 * The 09:30 rule, drawn straight through the log.
 *
 * On paper the arrival is an amber fill carrying near-black text, because
 * `#ffb000` on paper is 1.65:1. Here the ground is `#0b0b0a`, the ratio flips
 * to 10.75:1, and amber is allowed to be the text itself — which is the one
 * thing this band can do that no other band on the site can.
 */
function Arrival() {
  return (
    <div className="my-9 flex items-center gap-3">
      <span className="t-data shrink-0 text-[11px] leading-4 text-signal-500">
        09:30 YOU SIGN IN
      </span>
      <span aria-hidden className="h-0.5 flex-1 bg-signal-500" />
    </div>
  );
}

/**
 * The 24-hour strip.
 *
 * Same convention as the hero's board, deliberately: left to right is midnight
 * to midnight, a bar's left edge is when a Run started and its width is how
 * long the Run took, and the amber rule at 39.583% is 09:30. Redrawing the
 * same Tuesday in a second visual language would have made two charts that
 * disagree about what a rectangle means.
 *
 * The one difference is emphasis, and it is the reason the band is not just a
 * copy of the hero: Runs that started before 09:30 are filled, Runs after it
 * are outlined and empty. Every bar keeps the `night-600` edge (3.44:1) so the
 * distinction is fill, never visibility — a bar you cannot see is not a
 * de-emphasised bar, it is a missing one.
 */
function Strip() {
  return (
    <div className="min-w-[52rem] p-4">
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem]">
        <div className="relative pt-7">
          {/* One element, one gradient: the 24 hour columns. */}
          <div aria-hidden className="hours-night absolute top-7 right-0 bottom-6 left-0" />

          {/* Quarter marks, so the eye has something to measure against
              without the whole plate turning into graph paper. */}
          {[6, 12, 18].map((hour) => (
            <div
              key={hour}
              className="absolute top-7 bottom-6 w-px bg-night-600"
              style={{ left: pct(hour) }}
            />
          ))}

          {LANES.map((lane) => (
            <div key={lane.owner} className="relative h-[1.875rem] border-b border-night-700">
              {lane.events.map((event) => (
                <Bar key={`${lane.owner}-${event.at}`} event={event} />
              ))}
            </div>
          ))}

          <ArrivalRule />
          <HourScale />
        </div>

        {/* The owner column carries the chart's 1.75rem top offset so lane
            labels line up with their lanes, not with the flag row above. */}
        <div className="pt-7">
          {LANES.map((lane) => (
            <div
              key={lane.owner}
              className="flex h-[1.875rem] items-center border-b border-night-700 pl-4"
            >
              <Sheet night className="!text-[10px]">
                {lane.owner}
              </Sheet>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One event on the strip.
 *
 * A Decision or an Approval has no duration — it is a moment — so it is drawn
 * as its mark and its clock time in amber rather than as a bar. It carries no
 * label here: the three labels live in the "Waited for you" list below, where
 * they have room to be read, and hanging them off the chart is what made
 * adjacent lanes overlap into a smear on the previous version.
 */
function Bar({ event }: { event: BoardEvent }) {
  if (event.state !== "run") {
    return (
      <div
        className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-signal-500"
        style={{ left: pct(event.at) }}
      >
        <Mark state={event.state} className="h-2.5 w-2.5" />
        <span className="t-data whitespace-nowrap text-[10px] leading-none">
          {clock(event.at)}
        </span>
      </div>
    );
  }

  const overnight = event.at < ARRIVAL;

  return (
    <div
      className="absolute top-1/2 h-[1.125rem] min-w-[3px] -translate-y-1/2"
      style={{ left: pct(event.at), width: pct(event.hours ?? 0.25) }}
      title={`${clock(event.at)} · ${event.label}`}
    >
      <div
        className={`strip-draw h-full border border-night-600 border-l-[3px] border-l-paper-50 ${
          overnight ? "bg-night-800" : ""
        }`}
      />
    </div>
  );
}

/** The arrival line and its flag, in the one colour the site owns. */
function ArrivalRule() {
  return (
    <>
      <span
        className="arrive-in absolute top-0 flex h-[1.125rem] items-center whitespace-nowrap"
        style={{ left: pct(ARRIVAL) }}
      >
        <span className="t-data text-[10px] leading-none text-signal-500">09:30 YOU SIGN IN</span>
      </span>
      <span
        className="arrive-in absolute top-7 bottom-6 w-0.5 bg-signal-500"
        style={{ left: pct(ARRIVAL) }}
      />
    </>
  );
}

function HourScale() {
  return (
    <div className="relative h-6">
      {[0, 6, 12, 18].map((hour) => (
        <span
          key={hour}
          className="t-data absolute top-1.5 text-[10px] leading-none text-zinc-400"
          style={{ left: pct(hour) }}
        >
          {clock(hour)}
        </span>
      ))}
      <span className="t-data absolute top-1.5 right-0 text-[10px] leading-none text-zinc-400">
        24:00
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------
   Formatting.

   `clock` and `pct` are duplicated from Board rather than imported: Board
   keeps them private, and widening its public surface to share two four-line
   pure functions would make a data module into a utility one. The event data
   is imported, which is the part that can drift.
------------------------------------------------------------------------- */

/** Hours past midnight as a share of the day, for an inline position. */
function pct(hours: number): string {
  return `${(hours / 24) * 100}%`;
}

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
