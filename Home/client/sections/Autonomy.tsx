import {
  ArrowRight,
  Bot,
  CalendarClock,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  Container,
  Eyebrow,
  Heading,
  Lede,
  NightPanel,
  Section,
  TextLink,
} from "@/sections/Kit";

/**
 * The night-shift section — the page's central piece of evidence, and the one
 * dark band on the landing page.
 *
 * Everything else on the site asserts that the company keeps running; this
 * draws it. One Tuesday is laid out on a 24-hour rule, with the moment a human
 * first signed in marked in flame at 09:30. The work to the left of that
 * marker is the entire argument, so the timeline is the largest single element
 * in the section and the prose around it is deliberately short.
 *
 * The band is violet-cast rather than near-black on purpose: the section is
 * about a company humming along overnight, not about a datacentre at 3am.
 */

type DayEvent = {
  time: string;
  /** Hours past midnight. Drives the horizontal position on the rule. */
  at: number;
  body: string;
  where: string;
  /** Each area of the company keeps its own hue, here and in the product grid. */
  hue: string;
  /** Staggered above and below the rule so seven labels fit without collision. */
  side: "above" | "below";
};

const DAY: DayEvent[] = [
  {
    time: "01:20",
    at: 1.33,
    body: "Alex drafted the launch digest",
    where: "Marketing",
    hue: "bg-rose-400",
    side: "above",
  },
  {
    time: "04:05",
    at: 4.08,
    body: "Sam opened a fix for the error spike",
    where: "Repositories",
    hue: "bg-violet-400",
    side: "below",
  },
  {
    time: "07:00",
    at: 7,
    body: "Mira reconciled 42 payments",
    where: "Finance",
    hue: "bg-emerald-400",
    side: "above",
  },
  {
    time: "08:30",
    at: 8.5,
    body: "The morning TLDR landed",
    where: "Workspace",
    hue: "bg-sky-400",
    side: "below",
  },
  {
    time: "12:45",
    at: 12.75,
    body: "Alex cleared 12 support threads",
    where: "Email",
    hue: "bg-teal-400",
    side: "above",
  },
  {
    time: "16:40",
    at: 16.67,
    body: "Six deals moved a stage on evidence",
    where: "Revenue",
    hue: "bg-amber-400",
    side: "below",
  },
  {
    time: "21:15",
    at: 21.25,
    body: "Backups verified, tomorrow queued",
    where: "Operations",
    hue: "bg-fuchsia-400",
    side: "above",
  },
];

/** The moment a person first signed in. */
const ARRIVAL = 9.5;

const HOURS = [0, 6, 12, 18, 24];

const STATS = [
  { value: "18", label: "Routines ran overnight", hue: "text-flame-300" },
  { value: "0", label: "People signed in before 09:30", hue: "text-teal-300" },
  { value: "3", label: "Decisions that needed a human", hue: "text-amber-300" },
];

const ESCALATED = [
  { body: "Approve the $4,000 campaign budget", where: "Alex · Paid Marketing" },
  { body: "Sign off on the checkout patch before it merges", where: "Sam · Repositories" },
  { body: "Which entity books this refund?", where: "Mira · Finance" },
];

type Level = {
  icon: LucideIcon;
  title: string;
  tag: string;
  body: string;
  hue: string;
};

/**
 * The four levels are the product told as a ladder: chat, Skills, Routines,
 * and handoffs between employees. Each rung removes one more human trigger,
 * which is the whole claim of the page — a company that keeps running when
 * nobody is asking it to.
 */
const LEVELS: Level[] = [
  {
    icon: MessageSquare,
    title: "You ask, it does",
    tag: "Human starts it",
    body: "A Member asks in Workspace chat. The AI Employee does the work now, inside your systems, and leaves a Run you can read line by line.",
    hue: "bg-sky-400/15 text-sky-300 ring-sky-400/25",
  },
  {
    icon: Sparkles,
    title: "You write it down once",
    tag: "Human defines it",
    body: "Turn the ask into a Skill — trigger, steps, definition of done. Every employee who needs that job runs it the same way, without being told again.",
    hue: "bg-violet-400/15 text-violet-300 ring-violet-400/25",
  },
  {
    icon: CalendarClock,
    title: "It runs without being asked",
    tag: "No human needed",
    body: "Routines fire on cron. Reconciliation at 07:00, the brief at 08:30, the digest on Friday — through the night, through the weekend, through your holiday.",
    hue: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/25",
  },
  {
    icon: Bot,
    title: "The company keeps moving",
    tag: "Human by exception",
    body: "Employees pick up each other's handoffs across Tasks, Email, Revenue, and Repositories. What reaches you is the short list that genuinely needs a person.",
    hue: "bg-flame-400/15 text-flame-300 ring-flame-400/25",
  },
];

export function Autonomy() {
  return (
    <Section id="autonomy" tone="night" divide={false}>
      <div aria-hidden className="pointer-events-none absolute inset-0 aurora-night" />
      <div aria-hidden className="pointer-events-none absolute inset-0 night-grid" />
      <Container wide>
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
          <div>
            <Eyebrow night>
              The night shift
            </Eyebrow>
            <Heading night className="mt-6 max-w-2xl">
              Work that stops needing you to start it.
            </Heading>
          </div>
          <Lede night className="max-w-xl lg:pb-1">
            This is one Tuesday at a company running on Genosyn. Everything left of the orange line
            happened before a person opened a laptop.
          </Lede>
        </div>

        <DayStrip />

        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          {STATS.map((stat) => (
            <NightPanel key={stat.label} className="px-6 py-7">
              <div
                className={`tabular text-[3rem] font-semibold leading-none tracking-[-0.045em] ${stat.hue}`}
              >
                {stat.value}
              </div>
              <div className="mt-3 text-xs font-semibold text-violet-100/60">
                {stat.label}
              </div>
            </NightPanel>
          ))}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
          <NightPanel className="flex flex-col justify-between gap-8 p-6 sm:p-8">
            <div>
              <div className="text-xs font-semibold text-flame-300">
                The part people get wrong
              </div>
              <p className="mt-5 text-balance text-2xl font-semibold leading-[1.25] tracking-[-0.025em] text-white sm:text-[1.75rem]">
                An autonomous company is not one that never asks. It is one where the asking is
                rare, specific, and worth your time.
              </p>
            </div>
            <TextLink href="/docs/routines" night>
              Read how Routines and Runs work
              <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </TextLink>
          </NightPanel>

          <NightPanel className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-white/[0.10] px-5 py-4">
              <div className="text-[11px] font-semibold text-violet-100/70">
                Waited for you
              </div>
              <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-amber-200">
                3 items
              </span>
            </div>
            <ul className="divide-y divide-white/[0.08]">
              {ESCALATED.map((item) => (
                <li key={item.body} className="flex items-start gap-3 px-5 py-4">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-5 text-white">
                      {item.body}
                    </span>
                    <span className="mt-1 block font-mono text-[10px] text-violet-100/50">
                      {item.where}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </NightPanel>
        </div>

        <div className="mt-20">
          <Eyebrow night>
            How autonomy deepens
          </Eyebrow>
          <ol className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/[0.10] bg-white/[0.10] md:grid-cols-2 xl:grid-cols-4">
            {LEVELS.map((level, index) => (
              <li key={level.title} className="bg-night-950 p-6">
                <div className="flex items-center justify-between">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${level.hue}`}
                  >
                    <level.icon aria-hidden className="h-4 w-4" />
                  </span>
                  <span className="font-mono text-[10px] text-violet-100/40">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-6 text-base font-semibold text-white">{level.title}</h3>
                <div className="mt-2 text-[11px] font-semibold text-flame-300/90">
                  {level.tag}
                </div>
                <p className="mt-4 text-sm leading-6 text-violet-100/60">{level.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </Container>
    </Section>
  );
}

/**
 * The 24-hour rule.
 *
 * Positions are percentages of the day, so they are genuinely dynamic and have
 * to be inline styles. The strip keeps a fixed 64rem width and scrolls inside
 * its own container on narrow screens rather than reflowing — a timeline that
 * rewraps stops being a timeline.
 */
function DayStrip() {
  return (
    <figure className="mt-14">
      <div className="scrollbar-none -mx-5 overflow-x-auto px-5 sm:-mx-8 sm:px-8">
        <div className="relative h-[21rem] min-w-[64rem]">
          {/* The rule itself, plus a slow highlight travelling along it. */}
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-white/[0.16]" />
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-px overflow-hidden">
            <div className="day-sweep h-px w-1/4" />
          </div>

          {HOURS.map((hour) => (
            <div
              key={hour}
              aria-hidden
              className="absolute top-1/2 -translate-x-1/2"
              style={{ left: `${(hour / 24) * 100}%` }}
            >
              <span className="block h-2 w-px bg-white/25" />
              <span className="mt-1.5 block font-mono text-[10px] text-violet-100/40">
                {String(hour).padStart(2, "0")}:00
              </span>
            </div>
          ))}

          {/* The moment a person first showed up. */}
          <div
            className="absolute inset-y-6 -translate-x-1/2"
            style={{ left: `${(ARRIVAL / 24) * 100}%` }}
          >
            <span
              aria-hidden
              className="block h-full w-px bg-gradient-to-b from-transparent via-flame-400 to-transparent"
            />
            <span className="absolute -top-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-flame-400/40 bg-flame-500/15 px-3 py-1 text-[11px] font-semibold text-flame-200 backdrop-blur">
              09:30 · you sign in
            </span>
          </div>

          {DAY.map((event) => (
            <DayMarker key={event.time} event={event} />
          ))}
        </div>
      </div>
      <figcaption className="mt-4 text-[11px] font-semibold text-violet-100/40">
        A representative day · every item is one Run you can open and read
      </figcaption>
    </figure>
  );
}

function DayMarker({ event }: { event: DayEvent }) {
  const above = event.side === "above";
  const percent = (event.at / 24) * 100;

  // A card centred on its tick overhangs the strip at either end — 01:20 sits
  // at 5.6% of the day and a 13rem card is 10% of the rule, so half of it
  // lands off-canvas. Near the edges the card hangs off the tick instead of
  // straddling it; the connector below is drawn from the tick either way.
  const anchor = percent < 12 ? "left" : percent > 88 ? "right" : "center";
  const shift = { left: "-1.25rem", center: "-50%", right: "calc(-100% + 1.25rem)" }[anchor];
  const connector = { left: "1.25rem", center: "50%", right: "calc(100% - 1.25rem)" }[anchor];

  return (
    <div
      className={`absolute w-52 ${above ? "bottom-1/2 pb-7" : "top-1/2 pt-14"}`}
      style={{ left: `${percent}%`, transform: `translateX(${shift})` }}
    >
      <div className="rounded-xl border border-white/[0.12] bg-night-900/90 px-3.5 py-3 shadow-panel backdrop-blur">
        <div className="flex items-center gap-2">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${event.hue}`} />
          <span className="tabular font-mono text-[11px] font-semibold text-white">
            {event.time}
          </span>
          <span className="ml-auto text-[11px] font-semibold text-violet-100/50">
            {event.where}
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-violet-50/90">{event.body}</p>
      </div>
      <span
        aria-hidden
        className={`absolute w-px -translate-x-1/2 bg-white/20 ${
          above ? "bottom-0 h-7" : "top-0 h-14"
        }`}
        style={{ left: connector }}
      />
      <span
        aria-hidden
        className={`absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-night-950 ${event.hue}`}
        style={{ left: connector, top: above ? "100%" : "0" }}
      />
    </div>
  );
}
