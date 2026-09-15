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

/** The four app records needed to put one AI Employee to work. */

/** One line of the artefact column, with the department it belongs to. */
type ArtefactLine = {
  text: string;
  dept?: Dept;
};

type Step = {
  /** Displayed inside the numbered control; the `<ol>` carries the real order. */
  index: string;
  title: string;
  body: string;
  /** The department context for the step's small semantic marker. */
  dept?: Dept;
  /** What this step leaves behind, named. */
  artefact: string;
  lines: ArtefactLine[];
  /** The one step that results in a Decision rather than an Approval. */
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Chip dept="email">Email</Chip>
              <Field>4 STEPS · 1 ROUTINE · 07:00 EUROPE/LONDON</Field>
            </div>
          }
        />

        <ol className="mt-12 space-y-3">
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

/** One setup step, stacking the detail and resulting artifact on small screens. */
function StepRow({ step }: { step: Step }) {
  return (
    <Row dept={step.dept} className="flex-col sm:flex-row sm:items-start sm:py-7">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 font-mono text-xs font-semibold text-indigo-700">
        {step.index}
      </span>

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

        <div className="mt-6 rounded-lg border border-slate-100 bg-slate-50 p-4 lg:mt-0">
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
