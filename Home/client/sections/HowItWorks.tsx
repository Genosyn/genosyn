import {
  ArrowRight,
  CalendarClock,
  Files,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Container, Eyebrow, Heading, Lede, Section, TextLink } from "@/sections/Kit";

type Step = {
  number: string;
  icon: LucideIcon;
  title: string;
  body: string;
  detail: string;
  /** Tile skin and numeral colour. Each step owns one hue across both. */
  tile: string;
  numeral: string;
};

const STEPS: Step[] = [
  {
    number: "01",
    icon: Files,
    title: "Give the context",
    body: "Connect the company knowledge, data, conversations, and repositories the role actually needs.",
    detail: "Explicit Grants keep the working set scoped.",
    tile: "bg-sky-100 text-sky-700 ring-sky-200",
    numeral: "text-sky-300 group-hover:text-sky-500",
  },
  {
    number: "02",
    icon: ScrollText,
    title: "Write the role",
    body: "A Soul for judgment, Skills for the playbooks it repeats, and the AI Model behind both.",
    detail: "The whole role reads like a job description.",
    tile: "bg-violet-100 text-violet-700 ring-violet-200",
    numeral: "text-violet-300 group-hover:text-violet-500",
  },
  {
    number: "03",
    icon: CalendarClock,
    title: "Hand over the clock",
    body: "Put the work on cron and stop being the trigger. Routines run whether or not anyone is watching.",
    detail: "Nothing waits for someone to remember.",
    tile: "bg-emerald-100 text-emerald-700 ring-emerald-200",
    numeral: "text-emerald-300 group-hover:text-emerald-500",
  },
  {
    number: "04",
    icon: ShieldCheck,
    title: "Keep the final say",
    body: "Sensitive actions stop for a Member. Everything else keeps moving, with a Run you can read afterwards.",
    detail: "Autonomy with an audit trail.",
    tile: "bg-bloom-100 text-bloom-700 ring-bloom-200",
    numeral: "text-bloom-300 group-hover:text-bloom-500",
  },
];

/**
 * The setup story, told as four editorial rows rather than four cards.
 *
 * The section immediately above already ships a four-across grid (the autonomy
 * ladder); repeating that shape here made the page read as one long deck of
 * identical tiles. Hairline-separated rows with a large index numeral give the
 * same four beats a completely different texture.
 */
export function HowItWorks() {
  return (
    <Section id="how-it-works" divide={false}>
      <Container wide>
        <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-end">
          <div>
            <Eyebrow>How autonomy gets built</Eyebrow>
            <Heading className="mt-6 max-w-xl">
              Set the role up once. Then get out of its way.
            </Heading>
          </div>
          <div className="lg:pb-1">
            <Lede className="max-w-xl">
              An AI Employee is not something you operate. It has a constitution, repeatable
              playbooks, a schedule of its own, and exactly the access you granted it.
            </Lede>
            <TextLink href="/products/ai-employees" className="mt-6">
              Meet AI Employees
              <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </TextLink>
          </div>
        </div>

        <ol className="mt-16 border-t border-stone-900/[0.10]">
          {STEPS.map((step) => (
            <li
              key={step.number}
              className="group grid items-start gap-x-8 gap-y-4 border-b border-stone-900/[0.10] py-8 transition-colors hover:bg-white/70 sm:grid-cols-[auto_minmax(0,1fr)] lg:grid-cols-[7rem_minmax(0,1.05fr)_minmax(0,0.85fr)] lg:py-10"
            >
              <div className="flex items-center gap-4">
                <span
                  className={`tabular font-mono text-[2.5rem] font-semibold leading-none tracking-[-0.04em] transition-colors ${step.numeral}`}
                >
                  {step.number}
                </span>
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset lg:hidden ${step.tile}`}
                >
                  <step.icon aria-hidden className="h-4 w-4" />
                </span>
              </div>

              <div>
                <h3 className="text-xl font-semibold tracking-[-0.02em] text-stone-900 sm:text-2xl">
                  {step.title}
                </h3>
                <p className="mt-3 max-w-xl text-base leading-7 text-stone-600">{step.body}</p>
              </div>

              <div className="hidden items-start gap-3 lg:flex lg:justify-self-end">
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${step.tile}`}
                >
                  <step.icon aria-hidden className="h-4 w-4" />
                </span>
                <span className="max-w-[15rem] pt-1.5 text-sm leading-6 text-stone-500">
                  {step.detail}
                </span>
              </div>

              <p className="text-sm leading-6 text-stone-500 sm:col-start-2 lg:hidden">
                {step.detail}
              </p>
            </li>
          ))}
        </ol>
      </Container>
    </Section>
  );
}
