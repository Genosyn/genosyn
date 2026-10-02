import { useReveal } from "@/components/Reveal";
import { Container, Em, Section, SectionHead } from "@/sections/Kit";

/**
 * The premise, in four lines: the past set light, the future set solid.
 */
export function Prologue() {
  const lines = useReveal<HTMLDivElement>(0, 140);
  return (
    <Section space="lg" className="!pb-6 sm:!pb-10">
      <Container>
        <div ref={lines} className="max-w-[60rem]">
          <p className="text-balance font-display text-display-lg text-ink-300">
            Every company that has ever existed needed someone to run it.
          </p>
          <p className="mt-4 text-balance font-display text-display-lg text-ink-300">
            Someone to decide what happens next. Someone to review the work. Someone to pay the bills.
          </p>
          <p className="mt-4 font-display text-display-lg text-ink-300">Someone awake.</p>
          {/* A typeset apostrophe: at display size the straight one reads as a typewriter's. */}
          <p className="mt-12 font-display text-display-xl text-ink">{"The next ones won\u2019t."}</p>
        </div>
      </Container>
    </Section>
  );
}

/* -------------------------------------------------------------------------
   Two calendars: a week spent managing AI, and a month spent on its board
------------------------------------------------------------------------- */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const SLOTS = 9;
const CHORES = [
  "Write the prompt",
  "Review the draft",
  "Fix the draft",
  "Re-run it",
  "Approve a step",
  "Paste the output",
  "Chase an error",
  "Review it again",
  "Explain context",
  "Approve the send",
];

/** The month on the board: the letter on the 1st, one Decision on the 2nd. */
const MONTH_DAYS = 31;
const BOARD_DAYS: Record<number, { kind: "letter" | "decision"; label: string }> = {
  1: { kind: "letter", label: "Letter" },
  2: { kind: "decision", label: "Decision" },
};

const CONTRAST = [
  {
    q: "Who starts the work",
    manager: "You do, every time.",
    board: "The Goal does, through Routines that start themselves.",
  },
  {
    q: "Who reviews it",
    manager: "You do, line by line.",
    board: "Checks the company cannot rewrite, before anything counts as done.",
  },
  {
    q: "Who decides",
    manager: "You do, at every step.",
    board: "The executive team, up to a line the board drew. Above it, you.",
  },
  {
    q: "While you sleep",
    manager: "Nothing happens. The work waits for you.",
    board: "Everything happens. The company never waits for you.",
  },
];

export function Shift() {
  const cards = useReveal<HTMLDivElement>(0, 110);
  const rows = useReveal<HTMLDListElement>(0, 60);

  return (
    <Section id="shift" tone="raised" space="md" rule>
      <Container>
        <SectionHead
          kicker="The shift"
          title={
            <>
              Managing AI is a full-time job. <Em>Sitting on its board is not.</Em>
            </>
          }
          lede="Most AI still needs a person beside it: a prompt to start, a review to finish, a click to act. That person becomes the bottleneck, and the work stops when they do. A board does something else entirely. It sets the direction, appoints who runs things, reads how it is going, and steps in only where an owner must."
        />

        <div ref={cards} className="mt-14 grid gap-4 lg:grid-cols-2">
          <Week />
          <Month />
        </div>

        <dl ref={rows} className="mt-14 border-t border-line">
          <div aria-hidden className="hidden gap-8 pb-1 pt-5 sm:grid sm:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]">
            <span />
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">Managing AI</span>
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink">On the board</span>
          </div>
          {CONTRAST.map((row) => (
            <div
              key={row.q}
              className="grid gap-x-8 gap-y-1.5 border-b border-line py-5 sm:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)]"
            >
              <dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500 sm:pt-1">{row.q}</dt>
              <dd className="text-[15px] leading-6 text-ink-400">
                <span className="sr-only">Managing AI: </span>
                {row.manager}
              </dd>
              <dd className="text-[15px] leading-6 text-ink">
                <span className="sr-only">On the board: </span>
                {row.board}
              </dd>
            </div>
          ))}
        </dl>
      </Container>
    </Section>
  );
}

function Week() {
  return (
    <figure className="flex flex-col rounded-[1.75rem] border border-line bg-paper p-5 sm:p-7">
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="text-[15.5px] font-medium text-ink">Your week, managing AI</span>
        <span className="font-mono text-[12px] text-ink-500">51 hours</span>
      </figcaption>
      <div aria-hidden className="mt-6 grid grid-cols-5 gap-1.5">
        {WEEKDAYS.map((day) => (
          <span key={day} className="pb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400">
            {day}
          </span>
        ))}
        {Array.from({ length: SLOTS }, (_, slot) => slot).flatMap((slot) =>
          WEEKDAYS.map((day, d) => {
            const chore = CHORES[(d * 4 + slot * 3) % CHORES.length];
            const heavy = (d + slot) % 4 === 1;
            return (
              <span
                key={`${day}-${slot}`}
                className={`truncate rounded-md px-1.5 py-1.5 text-[10px] leading-tight sm:px-2 sm:text-[10.5px] ${
                  heavy ? "bg-ink/[0.13] text-ink-700" : "bg-ink/[0.06] text-ink-500"
                }`}
              >
                {chore}
              </span>
            );
          }),
        )}
      </div>
      <p className="mt-auto pt-6 text-[13.5px] leading-6 text-ink-500">
        Every block is you, standing between the software and the work.
      </p>
    </figure>
  );
}

function Month() {
  return (
    <figure className="flex flex-col rounded-[1.75rem] border border-ink bg-paper-raised p-5 shadow-lifted sm:p-7">
      <figcaption className="flex items-baseline justify-between gap-4">
        <span className="text-[15.5px] font-medium text-ink">Your month, on the board</span>
        <span className="font-mono text-[12px] text-ink">35 minutes</span>
      </figcaption>
      <div aria-hidden className="mt-6 grid grid-cols-7 gap-1.5">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span key={index} className="pb-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-400">
            {day}
          </span>
        ))}
        {Array.from({ length: 35 }, (_, index) => {
          const date = index + 1;
          if (date > MONTH_DAYS) return <span key={date} />;
          const seat = BOARD_DAYS[date];
          return (
            <span
              key={date}
              className={`relative flex h-11 flex-col justify-between rounded-md p-1.5 sm:h-12 ${
                seat?.kind === "letter"
                  ? "bg-ink text-white"
                  : seat?.kind === "decision"
                    ? "border border-ink text-ink"
                    : "border border-line text-ink-300"
              }`}
            >
              <span className="font-mono text-[10px] leading-none">{date}</span>
              {seat ? (
                <span className="truncate text-[9.5px] font-medium leading-none sm:text-[10.5px]">{seat.label}</span>
              ) : (
                <span className="h-1 w-1 rounded-full bg-moss-500/70" />
              )}
            </span>
          );
        })}
      </div>
      <ul className="mt-6 space-y-2 text-[13.5px] leading-5 text-ink-600">
        <li className="flex items-center gap-2.5">
          <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px] bg-ink" />
          The 1st: read the letter. Twenty-five minutes.
        </li>
        <li className="flex items-center gap-2.5">
          <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px] border border-ink" />
          The 2nd: answer one Decision. Ten minutes.
        </li>
        <li className="flex items-center gap-2.5">
          <span aria-hidden className="ml-1 mr-1 h-1 w-1 shrink-0 rounded-full bg-moss-500" />
          Every day: the company ran, 18,400 Runs in all, without you.
        </li>
      </ul>
    </figure>
  );
}
