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

/**
 * Sheet 04 — the shift.
 *
 * ## Why this band is no longer dark
 *
 * It was `tone="ink"`, and under the old palette that was right: the page had
 * one hue, night was a mood, and a black band was how you said "this happened * while you were asleep."
 *
 * HEADCOUNT takes that meaning away. Ink is now the HUMAN register — a
 * Decision, an Approval, the 09:30 rule, a primary control — and a whole band
 * in ink would say the whole band is about the person. It is not. It is about
 * seven departments working while nobody was there, which is the one thing on
 * the site that colour can carry on its own: every Run in the log below wears
 * its department's hue on a 3px spine, so reading down the column you watch
 * Finance, Repositories, Marketing, Workspace, Email, Revenue and Operations
 * interleave through the night without reading a word.
 *
 * So the band is `surface` — a white sheet lifted out of the paper ground
 * either side of it — and the only ink left in it is the three things that
 * needed a person. (It is not the page's only `surface` band: `InstallCta` in
 * Footer.tsx is the other, and the two are the sheet you read the evidence off
 * and the sheet you sign, which is a pairing rather than an accident.) That is
 * the inversion doing its job: on a band saturated with seven departments, the
 * eye finds four black objects, and every one of them is addressed to you.
 *
 * Dropping `night` from the chart is the same decision. In night mode the
 * Gantt draws every bar in `ink2` because a dark plane cannot carry seven
 * hues; in light mode it fills each bar with its department tint and puts a
 * hue swatch beside each lane name. The chart was already capable of being the
 * argument and the tone was preventing it.
 *
 * ## What the band is for
 *
 * The wall at the top of the page is one moment, seven surfaces, deliberately
 * unlabelled — captioning it would turn evidence into noise. That decision has
 * to be paid for somewhere, and this is where. Every overnight Run is printed
 * one per row with the clock time it started, its department and how long it
 * took. It is the most concrete thing on the page.
 *
 * Every number here is imported from `@/sections/Board`. The version before
 * last kept its own seven-event `DAY` array with different times and a
 * different arrival marker from the hero's, so the page quietly contradicted
 * itself twice. One event list, three projections: the wall, the chart, the
 * log.
 */

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

        {/* The night's result in three counts, tiled on 1px seams rather than
            set as three cards with air between them — the wall's construction,
            reused at the top of the band it explains.

            The third tile is ink and the other two are not, which is the whole
            system in one strip: eighteen Runs and zero people are what the
            machine did, and they are set on paper; three is what is left for
            you, and it is the only black object above the fold of this band.
            It summarises the "Waited for you" rows at the bottom — the same
            summary-then-detail relationship the chart has with the log, so it
            is a restatement in a different register rather than a repeat. */}
        <div className="mt-12 grid gap-px bg-seam sm:mt-14 sm:grid-cols-3">
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

          <div className="mt-6">
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

          <div className="mt-6">
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

/**
 * One of the band's three counts.
 *
 * `human` is not a style flag with a bad name — it is the palette rule. A
 * count of what the machine did is set on paper; the count of what needs a
 * person is set in ink, the one value with no hue. Nothing else in this file
 * may take it.
 *
 * On ink the label cannot be `Sheet`: `muted` is 5.14:1 on ground and 3.23:1
 * on ink, which fails. `ground/70` composites to 7.6:1 there, which passes,
 * and it is the construction the wall's eighth cell is meant to share so the
 * two black tiles on the page read as the same black tile. Wall.tsx currently
 * writes that cell's labels as `text-ink/70` on `bg-ink` — 1.00:1, invisible,
 * a casualty of the same token swap — so this is the correct one of the two
 * and Wall is the one to move, not this.
 */
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
    <div className={`flex flex-col justify-between gap-8 p-5 ${human ? "bg-ink" : "bg-surface"}`}>
      <span className={`t-field ${human ? "text-ground/70" : "text-muted"}`}>{label}</span>
      <div>
        <div
          className={`t-figure text-[clamp(2.75rem,5vw,4rem)] ${human ? "text-ground" : "text-ink"}`}
        >
          {value}
        </div>
        <p
          className={`mt-3 max-w-[26ch] text-[13px] leading-snug ${
            human ? "text-ground/85" : "text-ink2"
          }`}
        >
          {note}
        </p>
      </div>
    </div>
  );
}

/**
 * One Run in the log.
 *
 * The 3px spine is the department, and it is the reason this band no longer
 * needs a dark ground to feel like a night shift: eighteen rows in seven hues,
 * out of order and overlapping, IS a company working. The owner is still
 * printed as text beside the label — the hue is the fast read, the word is the
 * one that survives a monochrome print and a colour-blind reader, and colour
 * is never the only carrier of meaning on this site.
 *
 * The lane and the duration sit on the same flex line as the label and wrap
 * under it when there is no room. The alternative — hiding them below `sm` —
 * drops the two facts that make a row worth printing, and the first thing a
 * reader wants after "04:05" is "for how long".
 */
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

/**
 * A Decision or the Approval.
 *
 * These rows keep their department spine — a Decision belongs to Finance or to
 * Revenue like any other row, and dropping the hue here would say the
 * department stopped existing the moment it asked a question. What changes is
 * that the row carries an ink `StateTag`, so the three rows a person owns are
 * the only ones on the band with a black object in them.
 *
 * The tag carries the distinction AGENTS.md §3 insists on and every other
 * product collapses: a Decision is open on its right edge because the employee
 * stopped and asked, an Approval is barred across the middle because the
 * system interposed on something the employee had already started. The old
 * version drew all three with the same shield glyph and called the lot
 * "Escalated", which named neither.
 */
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

/**
 * The 09:30 rule, drawn straight through the log.
 *
 * It is ink, and on this band that is now a statement rather than a default:
 * the boundary between the machine's night and your morning is a human object,
 * so it takes the human value. The time sits on an ink tile at 16.4:1 and the
 * rule beside it is 2px, which is the same construction the board's own run
 * log uses — one arrival marker, drawn one way, wherever it appears.
 */
function Arrival() {
  return (
    <div className="my-9 flex items-center gap-3">
      <span className="t-data shrink-0 bg-ink px-1.5 py-1 text-[11px] leading-none text-ground">
        09:30 YOU SIGN IN
      </span>
      <span aria-hidden className="h-0.5 flex-1 bg-ink" />
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
