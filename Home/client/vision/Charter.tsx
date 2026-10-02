import { useReveal } from "@/components/Reveal";
import { Avatar, Container, Em, Section, SectionHead } from "@/sections/Kit";
import {
  BOARD,
  CEO,
  CEO_SOUL,
  COMPANY,
  EXECUTIVES,
  FIRST_HIRES,
  FIRST_MONTH,
  GOAL,
  type Executive,
} from "@/vision/data";

/**
 * One sentence in, a company out. The Goal is drawn solid because it is the
 * one thing on this surface a person wrote; everything under it, the company
 * wrote for itself.
 */
export function Charter() {
  const chart = useReveal<HTMLDivElement>(0, 90);
  const days = useReveal<HTMLOListElement>(0, 50);

  return (
    <Section id="company" space="md">
      <Container>
        <SectionHead
          kicker="One sentence"
          title={
            <>
              The board writes one sentence. <Em>The company writes everything else.</Em>
            </>
          }
          lede="A Goal is a measurable objective: a direction and a number. Give Genosyn one and it hires an AI CEO accountable for it. The CEO hires an executive team, the team hires AI Employees, and together they hire people for every job that needs hands."
        />

        <div ref={chart} className="mt-16">
          <GoalCard />
          <Stem />
          <CeoCard />
          <Executives />
          <PeopleStrip />
        </div>

        <div className="mt-20">
          <p className="kicker inline-flex items-center gap-3 text-ink-500">
            <span aria-hidden className="h-px w-6 bg-ink" />
            The first thirty days
          </p>
          <ol
            ref={days}
            className="mt-6 grid gap-px overflow-hidden rounded-3xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-6"
          >
            {FIRST_MONTH.map((moment) => (
              <li key={moment.title} className="bg-paper-raised p-5 sm:p-6">
                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">{`Day ${moment.day}`}</p>
                <p className="mt-3 text-[14.5px] font-medium leading-5 tracking-[-0.005em] text-ink">{moment.title}</p>
                <p className="mt-2 text-[13.5px] leading-5 text-ink-600">{moment.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </Container>
    </Section>
  );
}

function GoalCard() {
  return (
    <figure className="relative mx-auto max-w-[48rem] overflow-hidden rounded-[1.75rem] bg-ink px-7 pb-7 pt-7 text-white shadow-lifted sm:px-10 sm:pb-9 sm:pt-9">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/55">Goal · written by the board</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/35">{`${COMPANY} · day 0`}</span>
      </div>
      <blockquote className="mt-6 text-balance font-display text-[clamp(1.65rem,3.4vw,2.6rem)] leading-[1.08] tracking-[-0.038em]">
        {GOAL}
      </blockquote>
      <figcaption className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-white/10 pt-5">
        <span className="flex -space-x-1.5">
          {BOARD.map((director) => (
            <Avatar
              key={director.name}
              initials={director.initials}
              size="sm"
              night
              className={director.you ? "!bg-white !text-ink" : ""}
            />
          ))}
        </span>
        <span className="text-[13.5px] text-white/70">
          {"Signed by three directors. "}
          <span className="text-white">One of the seats is yours.</span>
        </span>
      </figcaption>
    </figure>
  );
}

function Stem({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`mx-auto block h-10 w-px bg-ink-300 sm:h-12 ${className}`} />;
}

function CeoCard() {
  return (
    <div className="mx-auto max-w-[36rem] rounded-3xl border border-line bg-paper-raised p-6 shadow-soft sm:p-7">
      <div className="flex items-center gap-3.5">
        <Avatar initials={CEO.initials} size="lg" />
        <div className="min-w-0">
          <p className="font-display text-[1.35rem] leading-tight tracking-[-0.03em] text-ink">{CEO.person}</p>
          <p className="text-[13px] text-ink-500">{`${CEO.title} · hired on day 0`}</p>
        </div>
        <span className="ml-auto hidden shrink-0 rounded-full border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500 sm:inline">
          Answers to the board
        </span>
      </div>
      <p className="mt-5 text-[14.5px] leading-6 text-ink-600">{CEO.remit}</p>
      <div className="mt-5 rounded-2xl border border-line bg-paper px-5 py-4">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">Soul · the first three lines</p>
        <ol className="mt-3 space-y-1.5">
          {CEO_SOUL.map((line, index) => (
            <li key={line} className="flex gap-3 text-[14.5px] leading-6 text-ink">
              <span className="w-4 shrink-0 font-mono text-[12px] leading-6 text-ink-400">{index + 1}</span>
              {line}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Executives() {
  return (
    <div>
      <Stem />
      <div className="relative">
        {/* The bus joins the five stubs: it runs from the first column's
            centre to the last's, which with four 1rem gaps is a tenth of the
            row less 0.4rem in from either side. */}
        <span
          aria-hidden
          className="absolute left-[calc((100%-4rem)/10)] right-[calc((100%-4rem)/10)] top-0 hidden h-px bg-ink-300 lg:block"
        />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:gap-4">
          {EXECUTIVES.map((executive) => (
            <li key={executive.person} className="relative min-w-0 lg:pt-9">
              <span aria-hidden className="absolute left-1/2 top-0 hidden h-9 w-px bg-ink-300 lg:block" />
              <ExecutiveCard executive={executive} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ExecutiveCard({ executive }: { executive: Executive }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-line bg-paper-raised p-5">
      <div className="flex items-center gap-3">
        <Avatar initials={executive.initials} dept={executive.dept} size="md" />
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-tight text-ink">{executive.person}</p>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-500">{executive.title}</p>
        </div>
      </div>
      <p className="mt-4 text-[13.5px] leading-5 text-ink-600">{executive.remit}</p>
      <p className="mt-auto pt-5">
        <span className="block border-t border-line pt-3 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-500">
          {`+${executive.team} AI Employees`}
        </span>
      </p>
    </div>
  );
}

function PeopleStrip() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-dashed border-line-strong px-5 py-4 sm:px-6">
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500">People hired in the first month</span>
      <span className="flex flex-wrap gap-2">
        {FIRST_HIRES.map((hire) => (
          <span key={hire} className="rounded-full border border-line bg-paper-raised px-3 py-1 text-[13px] text-ink">
            {hire}
          </span>
        ))}
      </span>
      <span className="text-[13px] text-ink-500 lg:ml-auto">Booked by Ines, paid by Vera, on the day of every shift.</span>
    </div>
  );
}
