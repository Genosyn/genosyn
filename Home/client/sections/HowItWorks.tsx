import {
  Band,
  Body,
  Container,
  Field,
  Heading,
  Lede,
  Rail,
  Row,
  Sheet,
  StateTag,
  TextLink,
} from "@/sections/Kit";

/**
 * Sheet 06 — setting one up.
 *
 * The editorial row was the right instinct in the version this replaces and it
 * survives. What went with it: the 2.5rem grey numeral, which was an ornament
 * loud enough to compete with the step title and too pale to pass a contrast
 * check, and the pastel icon tile, which was drawn twice per step (once for
 * mobile, once for desktop) and said nothing either time. The index now sits
 * in the rail's own idiom — a mono `Field` in the left column of a `Row` —
 * which is where every other number on this site lives.
 *
 * The third column changed job. It used to hold a summarising sentence
 * ("Autonomy with an audit trail"), which is the kind of line that sounds like
 * a conclusion and carries no information. It now holds the artefact the step
 * actually produces: two Grants, three Skill slugs, a cron line, a threshold.
 * You can read the whole setup down that column without reading a word of the
 * prose, which is the test.
 *
 * **Shape, against sheet 05.** The band above prints one document. This one is
 * a numbered sequence, and the two are deliberately built from different
 * primitives — a `Plate` there, a stack of `Row`s here — because two adjacent
 * four-item bands in the same shape is the monotony that made the old page
 * read as one long deck of tiles.
 *
 * The employee is a Support Rep rather than the Bookkeeper printed above, so
 * the two bands are not the same company record twice.
 */

type Step = {
  /** Rendered in the Field column. The `<ol>` carries the real order. */
  index: string;
  title: string;
  body: string;
  /** What this step leaves behind, named. */
  artefact: string;
  lines: string[];
  /**
   * Set on the one step that is about the human boundary. Amber is spent here
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
    artefact: "Grants",
    lines: ["gmail:support · send", "stripe · read"],
  },
  {
    index: "02",
    title: "Write a Soul and three Skills",
    body: "The Soul is the constitution: judgment, voice, and the lines it will not cross without asking. A Skill is a playbook for one job the company repeats. Both are markdown, and both are edited in place.",
    artefact: "Skills",
    lines: ["triage-inbox", "answer-refund-request", "close-resolved-threads"],
  },
  {
    index: "03",
    title: "Schedule the first Routine for 07:00",
    body: "A Routine is a brief, a schedule, and a Check it has to clear before the Run counts as green. From here it starts itself, and nobody has to remember it.",
    artefact: "Schedule",
    lines: ["0 7 * * *", "Europe/London"],
  },
  {
    index: "04",
    title: "Refunds over £500 stop for you",
    body: "It writes the question itself and attaches the account history, the contract and its recommendation. A Member answers it. Nothing moved in the meantime: Genosyn ships no tool that lets an AI Employee disburse a refund, so the worst case waiting in your queue is a well-argued question. Everything under £500 closes on its own.",
    artefact: "Threshold",
    lines: ["refund > 500 GBP"],
    decision: true,
  },
];

export function HowItWorks() {
  return (
    <Band id="how-it-works" open="m" close="s">
      <Container>
        <Rail sheet="06 / Setting one up" fields={["4 STEPS", "1 ROUTINE"]}>
          <Heading as="h2" className="max-w-[20ch]">
            The AI Support Rep&apos;s first answer lands at 07:00.
          </Heading>

          <Lede className="mt-7">
            This is the whole setup for one AI Employee. You do it once. After that the schedule
            owns the work, and the thing you read in the morning is a Run rather than an inbox.
          </Lede>

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
        </Rail>
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
 * It stacks below `sm`. A 2.5rem index gutter beside a display-face heading is
 * a column at 1024px and a squeeze at 375px, and the artefact list wants the
 * full measure on a phone.
 */
function StepRow({ step }: { step: Step }) {
  return (
    <Row className="flex-col sm:flex-row sm:py-9">
      <Field className="w-10 shrink-0 sm:pt-3">{step.index}</Field>

      <div className="min-w-0 flex-1 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.6fr)] lg:gap-10">
        <div>
          <Heading as="h3">{step.title}</Heading>
          <Body className="mt-4 max-w-[54ch]">{step.body}</Body>
        </div>

        <div className="mt-6 lg:mt-2">
          <Sheet>{step.artefact}</Sheet>
          <ul className="mt-3 space-y-2">
            {/* The artefact is the point of this column, so it is set one
                step darker than Kit's quiet floor. The `!` is not decoration:
                `text-zinc-700` and Kit's own `text-zinc-600` have identical
                specificity, so an unprefixed override wins only because
                Tailwind happens to emit the ramp in ascending order. That is
                a fact about the build, not about this file. */}
            {step.lines.map((line) => (
              <li key={line}>
                <Field className="block break-all !text-zinc-700">{line}</Field>
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
