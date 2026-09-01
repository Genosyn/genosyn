import {
  Band,
  Body,
  Chip,
  Container,
  Field,
  Head,
  Pane,
  Rule,
  Sheet,
  StateTag,
  TextLink,
} from "@/sections/Kit";

/**
 * Sheet 05 — what a role is made of.
 *
 * The band this replaces described four primitives in four cards, each card
 * owning a pastel hue it repeated three times (icon tile, gradient top edge,
 * bullet dot), under the headline "Not a prompt. A role that can run * unattended." That headline is the canonical antithesis and the hues were
 * decoration standing in for information, so both are gone rather than
 * restyled.
 *
 * What replaces them is the artefact itself. The four parts of an AI Employee
 * are not explained here; one employee is **printed** — three lines of its
 * Soul, its Skill slugs, its four Grants, and the Routine that ran at 04:05
 * with the verdicts of its last three Runs. A reader who wants to know what a
 * Soul is learns more from three sentences of one than from a paragraph about
 * the concept, and a cron line is not a claim anybody has to take on trust.
 *
 * ## Why it is mounted on a `Pane` and not a `Plate`
 *
 * The record used to sit inside a `Plate` — a plain bordered frame with a
 * numbered caption — which is the right mount for a picture and the wrong one
 * for this. The Bookkeeper is a Finance employee, and under HEADCOUNT that is
 * a fact the page can state without a word: `Pane` carries a 3px department
 * edge, so the record is filed under Finance green before a reader has
 * finished the heading, and the green edge here is the same green edge as the
 * Ledger pane on the wall and the Finance lane on the shift chart. One hue,
 * one department, three surfaces.
 *
 * The caption survives without `Plate` because `Plate` would have drawn its
 * own border around the `Pane`'s — two frames, and the department edge stranded
 * inside the inner one. The `<figure>` below is `Plate` minus that border, and
 * that is the only reason it is written out here rather than imported.
 *
 * The hue stops at the edge and the header chip. Nothing inside the record is
 * coloured: a Soul line is prose, a slug is data, and tinting either of them
 * would make green mean "important" instead of "Finance", which is the one
 * thing the palette forbids.
 *
 * ## Why one figure and not four
 *
 * The obvious move is four plates in a 2×2, and it is wrong twice: four
 * bordered boxes is the card grid this revamp exists to delete, and the band
 * immediately after this one is already four numbered rows. Two adjacent
 * four-item bands was the exact monotony the audit flagged. So this band is a
 * single mounted document with an uneven interior — a record on the left, one
 * Routine on the right — and sheet 06 is a numbered sequence. They no longer
 * rhyme.
 *
 * The employee is the AI Bookkeeper from `client/roles/data.ts`, and the one
 * number a reader can check against the hero is pinned on purpose: the 04:05
 * bar in the shift chart's Finance lane IS this Routine, so the cron line here
 * and the bar's width there have to say the same thing. `5 4 * * *` is 04:05
 * and `hours: 0.67` in Board.tsx is forty minutes; RUN-4471 therefore reads
 * 40m, not 41m. If Board's Finance lane moves, this file moves with it.
 *
 * The Decision below is the Soul's £25 line being hit, which is also what the
 * chart's Finance Decision is about. The question text is deliberately not
 * restated here — it lives on the chart, and copying a string across two files
 * is how two surfaces quietly stop agreeing. Note that this record and the
 * chart agree on the Routine, not on a single Decision row: the chart draws
 * its Finance Decision at a Tuesday clock time, so treating it as the literal
 * row RUN-4465 left on Sunday would be a claim neither file supports.
 */

/**
 * Three lines of the Soul, in prose rather than mono: this is a document a
 * person wrote, not a string the software emitted, and the mono predicate is
 * the only thing keeping the data on this site readable as data.
 *
 * The £25 line is load-bearing. It is why a Run stopped on a £42 discrepancy
 * instead of deciding for itself, which makes the Decision printed below a
 * consequence of something the reader can see rather than an assertion.
 */
const SOUL_LINES = [
  "Never state a figure I have not matched to a ledger line.",
  "Queue anything I cannot prove, and attach the evidence to it.",
  "Ask before writing off more than £25.",
];

/**
 * Skill slugs, exactly as they are stored. A slug describes itself, which is
 * why they are printed rather than glossed.
 *
 * These are the first three off the AI Bookkeeper in `client/roles/data.ts`
 * verbatim, not paraphrases of them. Inventing a plausible-looking slug here
 * is how the landing page and the role page start describing two different
 * employees, and the role page is one click away.
 */
const SKILLS = ["reconcile-payments", "chase-overdue-invoice", "categorise-spend"];

type Grant = {
  /** The resource kind: Connection, Note, Repository. */
  kind: string;
  /** The resource, as the software refers to it. */
  resource: string;
  scope: string;
};

const GRANTS: Grant[] = [
  { kind: "Connection", resource: "stripe", scope: "read" },
  { kind: "Connection", resource: "gmail:accounts", scope: "send" },
  { kind: "Note", resource: "month-end-pack", scope: "write" },
  { kind: "Repository", resource: "finance-docs", scope: "read" },
];

type RunLine = {
  ref: string;
  /** Day and clock. All three are identical because the cron line is real. */
  started: string;
  took: string;
  /** `Run.outcomeVerdict`, lowercase, as stored. */
  verdict: string;
  /** Set when the Run left a Decision on the stack for a person. */
  decisions?: number;
};

const RUNS: RunLine[] = [
  { ref: "RUN-4471", started: "TUE 04:05", took: "40m", verdict: "green" },
  { ref: "RUN-4468", started: "MON 04:05", took: "38m", verdict: "green" },
  { ref: "RUN-4465", started: "SUN 04:05", took: "44m", verdict: "unclear", decisions: 1 },
];

export function Primitives() {
  return (
    <Band tone="ground" open="m" close="s">
      <Container>
        <Head
          eyebrow="05 / Inside a role"
          title="The Bookkeeper is four editable parts."
          lede="An AI Employee is a Soul, a set of Skills, the Routines it keeps to, and the Grants that decide what it can reach. Below is one of ours, printed rather than described."
        />

        {/* The figure number follows the sheet number rather than a running
            count across the page, so two sections being rewritten in parallel
            cannot both claim Fig. 3. */}
        <figure className="mt-12">
          <Pane dept="finance">
            <RecordHead />

            {/* Below md the two halves stack and the divider becomes the
                horizontal rule between them, which is why the border is on the
                second child rather than on the grid. */}
            <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
              <Record />
              <RoutinePrint />
            </div>
          </Pane>

          <figcaption className="mt-3 flex flex-wrap items-baseline gap-x-3">
            <Sheet>Fig. 5</Sheet>
            <span className="text-[14px] italic leading-6 text-ink2">
              The Bookkeeper record, and the Routine that ran at 04:05.
            </span>
          </figcaption>
        </figure>

        <TextLink href="/roles/bookkeeper" className="mt-10">
          Read the Bookkeeper&rsquo;s day
        </TextLink>
      </Container>
    </Band>
  );
}

/**
 * The record's fascia.
 *
 * `Pane` takes a `title` and a `meta` string, and this uses neither: the chip
 * is the point. A 3px green edge on its own is an unlabelled colour, and a
 * legend that is never printed is not a legend — the chip names the department
 * once, in the same green, so the edge is decoded here and every other Finance
 * green on the site is decoded with it. It also means the department is not
 * carried by colour alone, which is the accessibility half of the same
 * decision.
 */
function RecordHead() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-hairline px-5 pt-5 pb-4 sm:px-6">
      <Chip dept="finance">Finance</Chip>
      <span className="t-h3 text-[15px] text-ink">AI Bookkeeper</span>
      <Field className="w-full sm:ml-auto sm:w-auto">5 SKILLS · 4 GRANTS · 1 ROUTINE</Field>
    </div>
  );
}

/** Soul, Skills and Grants: who it is, what it repeats, what it may touch. */
function Record() {
  return (
    <div className="p-5 sm:p-6">
      <SectionHead label="Soul" field="3 OF 41 LINES" />
      <ul className="mt-3">
        {SOUL_LINES.map((line) => (
          <li
            key={line}
            className="border-t border-hairline py-2.5 first:border-t-0 first:pt-0 last:pb-0"
          >
            <Body>{line}</Body>
          </li>
        ))}
      </ul>

      <Rule className="my-5" />

      {/* Counted the way the Soul above it is counted. The Bookkeeper holds
          five Skills; three are printed, so the field says so rather than
          letting a partial list read as the whole set. */}
      <SectionHead label="Skills" field="3 OF 5" />
      <ul className="mt-3 space-y-2">
        {SKILLS.map((slug) => (
          <li key={slug}>
            <Field className="block break-all">{slug}</Field>
          </li>
        ))}
      </ul>

      <Rule className="my-5" />

      <SectionHead label="Grants" field="4 RESOURCES" />
      <ul className="mt-3 space-y-2.5">
        {GRANTS.map((grant) => (
          <li key={grant.resource} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Sheet className="w-[5.5rem] shrink-0">{grant.kind}</Sheet>
            <Field className="min-w-0 break-all">{grant.resource}</Field>
            <Field className="ml-auto">{grant.scope}</Field>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One Routine, printed whole.
 *
 * Cron line, brief, the Check it has to clear, and the last three Runs. The
 * Check is the part most sites would leave out, and it is the part that makes
 * the rest credible: a Run that cannot fail is not a Run, and per AGENTS.md §3
 * the graded party cannot author its own Check.
 */
function RoutinePrint() {
  return (
    <div className="border-t border-hairline p-5 sm:p-6 md:border-t-0 md:border-l">
      <SectionHead label="Routine" field="ENABLED" />

      <Field className="mt-3 block !text-ink">Reconcile Stripe payments</Field>
      <Field className="mt-2 block">5 4 * * * Europe/London</Field>

      <Rule className="my-5" />

      <SectionHead label="Brief" />
      <Body className="mt-2">
        Match yesterday&rsquo;s Stripe payouts against open invoices, then post what is left over to
        the suspense account.
      </Body>

      <Rule className="my-5" />

      <SectionHead label="Check" />
      <Field className="mt-2 block break-all">unmatched_payments == 0</Field>

      <Rule className="my-5" />

      <SectionHead label="Last three Runs" />
      <ul className="mt-3 space-y-2.5">
        {RUNS.map((run) => (
          <li key={run.ref} className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <Field className="!text-ink">{run.ref}</Field>
            <Field>{run.started}</Field>
            <Field>{run.took}</Field>
            <Field>{run.verdict}</Field>
            {/* The only ink object inside a pane filed under Finance green, and
                that contrast is the argument in miniature: two of the three
                Runs closed themselves in the department's own colour, and the
                one that could not is black because it belongs to a person. The
                question itself is on the shift chart, in the Finance lane, and
                is not duplicated here. */}
            {run.decisions ? (
              <StateTag state="decision">{`${run.decisions} Decision`}</StateTag>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A label inside the printed record, with an optional count beside it. */
function SectionHead({ label, field }: { label: string; field?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <Sheet>{label}</Sheet>
      {field && <Field>{field}</Field>}
    </div>
  );
}
