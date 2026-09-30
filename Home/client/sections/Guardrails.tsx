import type { ReactNode } from "react";
import { BadgeCheck, CircleSlash2, Hand, KeyRound, MessageCircleQuestion, type LucideIcon } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Avatar, Container, Em, Section, SectionHead, StateTag, TextLink } from "@/sections/Kit";

type Instrument = {
  icon: LucideIcon;
  name: string;
  tag?: ReactNode;
  body: string;
};

/**
 * The instruments, in the order a reader meets them. The copy keeps the lines
 * AGENTS.md §3 draws: a Decision performs no side effect; an Approval replays
 * an action already attempted; a Check cannot be written by the party it
 * grades; a Standdown cannot be lifted by the party it stops.
 */
const INSTRUMENTS: Instrument[] = [
  {
    icon: MessageCircleQuestion,
    name: "Decisions",
    tag: <StateTag state="decision">Decision</StateTag>,
    body: "The employee chooses to stop and ask. It writes the question and the options itself, any Member can answer, and answering performs no side effect.",
  },
  {
    icon: Hand,
    name: "Approvals",
    tag: <StateTag state="approval">Approval</StateTag>,
    body: "The system holds an action the employee already attempted — a gated Routine, a spend increase, an exact email — until an admin ticks it. Then the server replays exactly that.",
  },
  {
    icon: BadgeCheck,
    name: "Checks",
    body: "A machine-verifiable assertion a Run must pass before it counts as green. The employee being graded can read its Checks and can never write them.",
  },
  {
    icon: CircleSlash2,
    name: "Standdowns",
    tag: <StateTag state="standdown">Standdown</StateTag>,
    body: "One switch stops all AI work for a company, an employee or a Routine. A person places it, and only a person can lift it.",
  },
  {
    icon: KeyRound,
    name: "Grants",
    body: "Access to one named resource at a time — a Connection, a notebook, a Repository. Anything not granted is unreachable, including the rest of the same Integration.",
  },
];

export function Guardrails() {
  const list = useReveal<HTMLUListElement>(0, 70);
  const card = useReveal<HTMLDivElement>(80);

  return (
    <Section id="guardrails" space="md">
      <Container>
        <SectionHead
          kicker="Guardrails"
          title={
            <>
              It stops for you <Em>only where it matters.</Em>
            </>
          }
          lede="Autonomy is not a leap of faith. Every AI Employee works inside Grants you chose, and every consequential step comes to a person first."
        />

        <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
          <div ref={card} className="relative">
            <DecisionCard />
          </div>

          <ul ref={list} className="divide-y divide-line border-y border-line">
            {INSTRUMENTS.map((instrument) => (
              <li key={instrument.name} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 py-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-paper-raised">
                  <instrument.icon aria-hidden className="h-[18px] w-[18px] text-ink" strokeWidth={1.6} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-display text-[1.45rem] leading-tight tracking-[-0.01em] text-ink">
                      {instrument.name}
                    </h3>
                    {instrument.tag}
                  </div>
                  <p className="mt-2 max-w-[56ch] text-[14.5px] leading-6 text-ink-600">{instrument.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
          <TextLink href="/docs/decisions">How Decisions work</TextLink>
          <TextLink href="/docs/standdowns">Standdowns</TextLink>
          <TextLink href="/docs/security">Security</TextLink>
        </div>
      </Container>
    </Section>
  );
}

/** One Decision as a Member meets it: the question, the context, the options. */
function DecisionCard() {
  return (
    <div className="relative isolate lg:sticky lg:top-28">
      <div className="dot-paper absolute -inset-4 -z-10 rounded-[2.25rem] opacity-70 sm:-inset-6" aria-hidden />
      <figure className="overflow-hidden rounded-[1.75rem] border border-line bg-paper-raised shadow-lifted">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <Avatar initials="MI" dept="finance" size="md" />
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-ink">Mira</p>
            <p className="text-[12.5px] text-ink-500">AI Bookkeeper · Finance</p>
          </div>
          <StateTag state="decision" className="ml-auto">
            Decision
          </StateTag>
        </div>

        <div className="px-6 pb-6 pt-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">Tuesday · 10:40</p>
          <p className="mt-3 font-display text-[1.9rem] leading-[1.1] tracking-[-0.02em] text-ink sm:text-[2.2rem]">
            Write off a £42 discrepancy, or chase it?
          </p>
          <p className="mt-4 text-[14.5px] leading-6 text-ink-600">
            Last night&rsquo;s payout came in £42 short of the invoice it settles. My Soul says to ask
            before writing off more than £25, so I have not posted anything.
          </p>

          <div className="mt-6 space-y-2" role="group" aria-label="Options Mira wrote">
            <Option picked label="Chase it" detail="Email the customer the invoice and the payout, and hold the £42 as open." />
            <Option label="Write it off" detail="Post the £42 to the suspense account and close the invoice." />
          </div>
        </div>

        <figcaption className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-6 py-4 text-[12.5px] leading-5 text-ink-500">
          <span>Any Member can answer. Answering performs no side effect.</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">Illustrative</span>
        </figcaption>
      </figure>
    </div>
  );
}

function Option({ label, detail, picked = false }: { label: string; detail: string; picked?: boolean }) {
  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3.5 ${
        picked ? "border-ink bg-ink text-white" : "border-line bg-paper text-ink"
      }`}
    >
      <span
        aria-hidden
        className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          picked ? "border-white" : "border-ink-300"
        }`}
      >
        {picked && <span className="h-2 w-2 rounded-full bg-white" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14.5px] font-medium">{label}</span>
        <span className={`mt-0.5 block text-[13.5px] leading-5 ${picked ? "text-white/70" : "text-ink-500"}`}>{detail}</span>
      </span>
    </div>
  );
}
