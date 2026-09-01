import {
  Band,
  Body,
  Chip,
  Container,
  Field,
  Head,
  Row,
  Sheet,
  StateTag,
  Subhead,
  TextLink,
  type Dept,
} from "@/sections/Kit";

/**
 * Sheet 06 — setting one up.
 *
 * The editorial row was the right instinct in the version this replaces and it
 * survives. What went with it: the 2.5rem grey numeral, which was an ornament
 * loud enough to compete with the step title and too pale to pass a contrast
 * check, and the pastel icon tile, which was drawn twice per step (once for
 * mobile, once for desktop) and said nothing either time. The index now sits
 * in the site's own idiom — a mono `Field` in the left column of a `Row` —
 * which is where every other number on this site lives.
 *
 * The third column changed job. It used to hold a summarising sentence
 * ("Autonomy with an audit trail"), which is the kind of line that sounds like
 * a conclusion and carries no information. It now holds the artefact the step
 * actually produces: two Grants, three Skill slugs, a cron line, a threshold.
 * You can read the whole setup down that column without reading a word of the
 * prose, which is the test.
 *
 * ## The spines, and why three of them are the same colour
 *
 * Each `Row` carries the 3px edge of the department the step happens in, and
 * for the first three that department is Email — because the Support Rep is an
 * Email employee, and granting, writing and scheduling all happen inside the
 * department that will do the work.
 *
 * Giving the four steps four different hues would have made a livelier column
 * and it was rejected outright: the hue would then mean "step index", and a
 * hue that means anything other than its department is the one thing HEADCOUNT
 * forbids. A reader who has decoded the wall knows blue is Email; if step 03
 * were teal they would look for the Workspace in it and not find one.
 *
 * The variation that IS real is printed instead. Step 01 grants two
 * Connections and they belong to two different departments — `gmail:support`
 * to Email and `stripe` to Finance — so each granted line carries its own
 * chip. That is the actual fact worth colouring: a Grant reaches across the
 * org chart, and one step in this band does it once.
 *
 * ## The fourth step has no department
 *
 * It is ink, because it is you. The other three spines are a department's
 * colour; the fourth is the one value in the palette with no hue at all, which
 * is the same inversion the wall's eighth cell makes and the same one the
 * `StateTag` beside it makes. Three coloured rows and one black row is the
 * whole product argument drawn down a 3px column.
 *
 * **Shape, against sheet 05.** The band above prints one document. This one is
 * a numbered sequence, and the two are deliberately built from different
 * primitives — a `Pane` there, a stack of `Row`s here — because two adjacent
 * four-item bands in the same shape is the monotony that made the old page
 * read as one long deck of tiles.
 *
 * The employee is a Support Rep rather than the Bookkeeper printed above, so
 * the two bands are not the same company record twice.
 */

/** One line of the artefact column, with the department it belongs to. */
type ArtefactLine = {
  text: string;
  dept?: Dept;
};

type Step = {
  /** Rendered in the Field column. The `<ol>` carries the real order. */
  index: string;
  title: string;
  body: string;
  /**
   * The department the step happens in, drawn as the row's 3px spine.
   *
   * Absent on the step that is about the human boundary, which takes ink
   * instead. That is not a missing value — it is the palette's central rule,
   * so the type says the department is optional and the renderer says what
   * happens when it is not there.
   */
  dept?: Dept;
  /** What this step leaves behind, named. */
  artefact: string;
  lines: ArtefactLine[];
  /**
   * Set on the one step that is about the human boundary. Ink is spent here
   * and nowhere else in the band.
   *
   * It is a Decision rather than an Approval, and the difference is checkable
   * rather than a matter of taste. An Approval replays an action the employee
   * already attempted, so it needs a tool the employee could call; Genosyn
   * ships none that disburses a refund, and `client/roles/data.ts` files the
   * Support Rep's over-policy refund as `kind: "decision"` for exactly that
   * reason. A reader is one click from that page.
   */
  decision?: boolean;
};

const STEPS: Step[] = [
  {
    index: "01",
    title: "Grant the Support Rep two Connections",
    body: "A Grant is access to one named resource. Anything you have not granted stays unreachable, including the rest of the same Integration, so the working set is whatever is printed beside this step and nothing else.",
    dept: "email",
    artefact: "Grants",
    lines: [
      { text: "gmail:support · send", dept: "email" },
      { text: "stripe · read", dept: "finance" },
    ],
  },
  {
    index: "02",
    title: "Write a Soul and three Skills",
    body: "The Soul is the constitution: judgment, voice, and the lines it will not cross without asking. A Skill is a playbook for one job the company repeats. Both are markdown, and both are edited in place.",
    dept: "email",
    artefact: "Skills",
    lines: [
      { text: "triage-inbox" },
      { text: "answer-refund-request" },
      { text: "close-resolved-threads" },
    ],
  },
  {
    index: "03",
    title: "Schedule the first Routine for 07:00",
    body: "A Routine is a brief, a schedule, and a Check it has to clear before the Run counts as green. From here it starts itself, and nobody has to remember it.",
    dept: "email",
    artefact: "Schedule",
    lines: [{ text: "0 7 * * *" }, { text: "Europe/London" }],
  },
  {
    index: "04",
    title: "Refunds over £500 stop for you",
    body: "It writes the question itself and attaches the account history, the contract and its recommendation. A Member answers it. Nothing moved in the meantime: Genosyn ships no tool that lets an AI Employee disburse a refund, so the worst case waiting in your queue is a well-argued question. Everything under £500 closes on its own.",
    artefact: "Threshold",
    lines: [{ text: "refund > 500 GBP" }],
    decision: true,
  },
];

export function HowItWorks() {
  return (
    <Band id="how-it-works" tone="surface" open="m" close="s">
      <Container>
        <Head
          eyebrow="06 / Setting one up"
          title={<>The AI Support Rep&rsquo;s first answer lands at 07:00.</>}
          lede="This is the whole setup for one AI Employee. You do it once. After that the schedule owns the work, and the thing you read in the morning is a Run rather than an inbox."
          aside={
            /* The chip decodes the three blue spines below before the reader
               meets them: this employee joins Email, and every hue on the site
               names a department rather than a step. */
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Chip dept="email">Email</Chip>
              <Field>4 STEPS · 1 ROUTINE · 07:00 EUROPE/LONDON</Field>
            </div>
          }
        />

        <ol className="mt-12">
          {STEPS.map((step) => (
            <li key={step.index}>
              <StepRow step={step} />
            </li>
          ))}
        </ol>

        <TextLink href="/products/ai-employees" className="mt-10">
          Read how a role is written
        </TextLink>
      </Container>
    </Band>
  );
}

/**
 * One step.
 *
 * The Kit's `Row` and nothing else: its -mt-px stacking is what gives a run of
 * rows one shared rule between each pair rather than two abutting borders, and
 * re-implementing that inline is how a site ends up with two row primitives.
 *
 * `Row` draws the spine itself when it is given a department. The human step
 * has none, so this draws an ink one in the same place and takes the same
 * `pl-4` — the `!` is what makes that override `Row`'s own `px-1` rather than
 * relying on the order Tailwind happens to emit padding utilities in, which is
 * a fact about the build and not about this file.
 *
 * It stacks below `sm`. A 2.5rem index gutter beside a display-face heading is
 * a column at 1024px and a squeeze at 375px, and the artefact list wants the
 * full measure on a phone.
 */
function StepRow({ step }: { step: Step }) {
  return (
    <Row dept={step.dept} className={`flex-col sm:flex-row sm:py-9 ${step.dept ? "" : "!pl-4"}`}>
      {!step.dept && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}

      <Field className="w-10 shrink-0 sm:pt-3">{step.index}</Field>

      <div className="min-w-0 flex-1 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)] lg:gap-10">
        <div>
          {/* `Subhead` (t-h3), not `Heading` (t-h2). Kit reserves t-h2 for band
              heads, and the token swap had grown `Heading` to
              clamp(1.875rem,3.4vw,3.25rem) — so all four step titles were
              rendering at 47.6px, the exact size of this band's own head. Four
              children shouting as loud as their parent is not a hierarchy, and
              at that scale the four rows also stopped reading as one sequence.
              Rejected the alternative of clamping `Heading` down with a `!`
              override, which is what RolePage does: the Kit already has the
              primitive for a head inside a row, and reaching past it for a
              bang-suffixed size is how a type ramp turns back into call-site
              inline styles. */}
          <Subhead as="h3">{step.title}</Subhead>
          <Body className="mt-4 max-w-[54ch]">{step.body}</Body>
        </div>

        <div className="mt-6 lg:mt-2">
          <Sheet>{step.artefact}</Sheet>
          <ul className="mt-3 space-y-2">
            {/* The artefact is the point of this column, so it is set one step
                darker than Kit's quiet floor. The `!` is not decoration:
                `text-ink2` and Kit's own `text-muted` have identical
                specificity, so an unprefixed override wins only because
                Tailwind happens to emit the ramp in ascending order. That is a
                fact about the build, not about this file. */}
            {step.lines.map((line) => (
              <li key={line.text} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                {line.dept && <Chip dept={line.dept}>{line.dept}</Chip>}
                <Field className="min-w-0 break-all !text-ink2">{line.text}</Field>
              </li>
            ))}
          </ul>
          {step.decision && (
            <StateTag state="decision" className="mt-3">
              Decision
            </StateTag>
          )}
        </div>
      </div>
    </Row>
  );
}
