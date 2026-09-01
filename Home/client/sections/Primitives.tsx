import {
  Band,
  Body,
  Container,
  Display,
  Field,
  Lede,
  Plate,
  Rail,
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
 * bullet dot), under the headline "Not a prompt. A role that can run
 * unattended." That headline is the canonical antithesis and the hues were
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
 * **Why one figure and not four.** The obvious move is four plates in a 2×2,
 * and it is wrong twice: four bordered boxes is the card grid this revamp
 * exists to delete, and the band immediately after this one is already four
 * numbered rows. Two adjacent four-item bands was the exact monotony the audit
 * flagged. So this band is a single mounted document with an uneven interior —
 * a record on the left, one Routine on the right — and sheet 06 is a numbered
 * sequence. They no longer rhyme.
 *
 * The employee is the AI Bookkeeper from `client/roles/data.ts`, and the one
 * number a reader can check against the hero is pinned on purpose: the 04:05
 * bar in the board's Finance lane IS this Routine, so the cron line here and
 * the bar's width there have to say the same thing. `5 4 * * *` is 04:05 and
 * `hours: 0.67` in Board.tsx is forty minutes; RUN-4471 therefore reads 40m,
 * not 41m. If Board's Finance lane moves, this file moves with it.
 *
 * The Decision below is the Soul's £25 line being hit, which is also what the
 * board's Finance Decision is about. The question text is deliberately not
 * restated here — it lives on the board, and copying a string across two
 * files is how two surfaces quietly stop agreeing. Note that this record and
 * the board agree on the Routine, not on a single Decision row: the board
 * draws its Finance Decision at a Tuesday clock time, so treating it as the
 * literal row RUN-4465 left on Sunday would be a claim neither file supports.
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
    <Band pad="m">
      <Container>
        <Rail sheet="05 / What a role is made of" fields={["BOOKKEEPER", "5 SKILLS", "4 GRANTS"]}>
          <Display as="h2" className="max-w-[20ch]">
            The Bookkeeper is four editable parts.
          </Display>

          <Lede className="mt-7">
            An AI Employee is a Soul, a set of Skills, the Routines it keeps to, and the Grants that
            decide what it can reach. Below is one of ours, printed rather than described.
          </Lede>

          {/* The figure number follows the sheet number rather than a running
              count across the page, so two sections being rewritten in
              parallel cannot both claim Fig. 3. */}
          <Plate
            className="mt-12"
            figure="Fig. 5"
            caption="The Bookkeeper record, and the Routine that ran at 04:05."
          >
            <div className="border border-paper-400 bg-paper-50">
              {/* Below md the two halves stack and the divider becomes the
                  horizontal rule between them, which is why the border is on
                  the second child rather than on the grid. */}
              <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
                <Record />
                <RoutinePrint />
              </div>
            </div>
          </Plate>

          <TextLink href="/roles/bookkeeper" className="mt-10">
            Read the Bookkeeper&rsquo;s day
          </TextLink>
        </Rail>
      </Container>
    </Band>
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
            className="border-t border-paper-300 py-2.5 first:border-t-0 first:pt-0 last:pb-0"
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
    <div className="border-t border-paper-400 p-5 sm:p-6 md:border-t-0 md:border-l">
      <SectionHead label="Routine" field="ENABLED" />

      <Field className="mt-3 block !text-zinc-950">Reconcile Stripe payments</Field>
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
            <Field className="!text-zinc-950">{run.ref}</Field>
            <Field>{run.started}</Field>
            <Field>{run.took}</Field>
            <Field>{run.verdict}</Field>
            {/* The one amber element in this band, and it obeys the rule that
                colour marks the row needing a person and nothing else. The
                question itself is on the board in the hero, in the Finance
                lane, and is not duplicated here. */}
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
