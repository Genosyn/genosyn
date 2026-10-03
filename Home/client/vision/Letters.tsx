import { useEffect, useId, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useReveal } from "@/components/Reveal";
import { Avatar, Container, Section, SectionHead, StateTag } from "@/sections/Kit";
import { CEO, COMPANY, GOAL_ROOFS, LETTERS, TAGLINE, type BoardDecision, type Letter } from "@/vision/data";

/** No. 12 opens: a year in, a mistake owned, and the first Decision for the board. */
const FIRST_SHOWN = 1;

/* -------------------------------------------------------------------------
   The curve: monthly revenue across the twenty years the letters cover,
   drawn to scale. Between two letters revenue compounds smoothly from one
   to the next, so the line passes exactly through every letter's number.
------------------------------------------------------------------------- */

const CW = 1000;
const CH = 240;
const TOP = 16;
const BASE = CH - 6;
const LAST = LETTERS[LETTERS.length - 1];

const cx = (month: number) => (month / LAST.number) * CW;
const cy = (revenue: number) => BASE - (revenue / LAST.revenue) * (BASE - TOP);
const round = (n: number) => Math.round(n * 10) / 10;

function revenueAt(month: number): number {
  for (let i = 0; i < LETTERS.length - 1; i++) {
    const from = LETTERS[i];
    const to = LETTERS[i + 1];
    if (month <= to.number) {
      const t = Math.max(0, (month - from.number) / (to.number - from.number));
      return from.revenue * Math.pow(to.revenue / from.revenue, t);
    }
  }
  return LAST.revenue;
}

const CURVE = Array.from({ length: LAST.number }, (_, i) => i + 1)
  .map((month, i) => `${i === 0 ? "M" : "L"}${round(cx(month))} ${round(cy(revenueAt(month)))}`)
  .join("");
const AREA = `${CURVE}L${CW} ${BASE}L${round(cx(1))} ${BASE}Z`;

const YEAR_TICKS = [0, 5, 10, 15, 20];

/** $192,000 · $2.4M · $46M · $1.2B — never "$46.0M". */
function money(value: number): string {
  const short = (n: number) => (n >= 100 ? `${Math.round(n)}` : n.toFixed(1).replace(/\.0$/, ""));
  if (value >= 1_000_000_000) return `$${short(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `$${short(value / 1_000_000)}M`;
  return `$${value.toLocaleString("en-US")}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function Letters() {
  const [index, setIndex] = useState(FIRST_SHOWN);
  const [touched, setTouched] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const frame = useReveal<HTMLDivElement>(60);
  const letter = LETTERS[index];

  const pick = (next: number) => {
    setIndex(next);
    setTouched(true);
  };

  return (
    <Section id="letters" tone="sunken" space="md">
      <Container>
        <SectionHead
          kicker="The board letter"
          title="Once a month, it writes to you."
          lede="No dashboard to babysit, no status meeting, and almost nothing to decide. On the first of every month the AI CEO writes to the board: what happened, what it got wrong, and where the money went, every figure checked by an auditor the company cannot appoint. Twenty minutes to read. Once in a long while, a question only an owner can answer."
        />

        <div ref={frame} className="mt-14">
          <Curve index={index} onPick={pick} />
          <LetterTabs index={index} onPick={pick} />

          <div
            id="letter-panel"
            role="tabpanel"
            aria-labelledby={`letter-tab-${letter.number}`}
            className="mt-5"
          >
            <div key={letter.number} className={touched ? "settle" : ""}>
              <LetterSheet
                letter={letter}
                answer={answers[letter.number]}
                onAnswer={(label) => setAnswers((current) => ({ ...current, [letter.number]: label }))}
              />
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

/* -------------------------------------------------------------------------
   The curve, with a marker on every letter
------------------------------------------------------------------------- */

function Curve({ index, onPick }: { index: number; onPick: (index: number) => void }) {
  const chart = useRef<SVGSVGElement>(null);

  // Whole in the prerendered page; hidden only once the script knows it can
  // draw the line back in when it scrolls into view.
  useEffect(() => {
    const node = chart.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const box = node.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) return;
    node.dataset.draw = "pending";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        node.dataset.draw = "running";
        observer.disconnect();
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      delete node.dataset.draw;
    };
  }, []);

  const active = LETTERS[index];
  const left = cx(active.number) / CW;

  return (
    <figure className="rounded-[1.75rem] border border-line bg-paper-raised px-5 pb-5 pt-6 sm:px-8 sm:pb-6 sm:pt-7">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="text-[15px] font-medium text-ink">{`${COMPANY}'s revenue, month by month, drawn to scale`}</span>
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-400">
          {`Top of the scale: ${money(LAST.revenue)} a month`}
        </span>
      </figcaption>

      <div aria-hidden className="relative mt-8 h-40 sm:h-56">
        <svg
          ref={chart}
          viewBox={`0 0 ${CW} ${CH}`}
          preserveAspectRatio="none"
          className="vl-chart absolute inset-0 h-full w-full overflow-visible"
        >
          {YEAR_TICKS.slice(1).map((year) => (
            <line
              key={year}
              x1={cx(year * 12)}
              x2={cx(year * 12)}
              y1={TOP}
              y2={BASE}
              stroke="#0E0E0D"
              strokeOpacity="0.06"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line x1="0" x2={CW} y1={BASE} y2={BASE} stroke="#0E0E0D" strokeOpacity="0.18" vectorEffect="non-scaling-stroke" />
          <path d={AREA} fill="#0E0E0D" fillOpacity="0.045" className="vl-area" />
          <path
            d={CURVE}
            pathLength={1}
            fill="none"
            stroke="#0E0E0D"
            strokeWidth="2"
            strokeLinejoin="round"
            className="vl-curve"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Markers are HTML, so they stay round however the chart stretches. */}
        {LETTERS.map((item, i) => {
          const selected = i === index;
          return (
            <button
              key={item.number}
              type="button"
              tabIndex={-1}
              onClick={() => onPick(i)}
              className={`absolute z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-transform duration-200 hover:scale-125 ${
                selected ? "scale-125 border-ink bg-ink shadow-[0_0_0_5px_rgb(14_14_13/0.1)]" : "border-ink bg-paper-raised"
              }`}
              style={{ left: `${(cx(item.number) / CW) * 100}%`, top: `${(cy(item.revenue) / CH) * 100}%` }}
            >
              <span className="sr-only">{`Letter No. ${item.number}`}</span>
            </button>
          );
        })}

        <span
          className={`pointer-events-none absolute z-20 -mt-4 -translate-y-full whitespace-nowrap rounded-full bg-ink px-2.5 py-1 font-mono text-[10.5px] leading-none text-white ${
            left < 0.2 ? "" : left > 0.8 ? "-translate-x-full" : "-translate-x-1/2"
          }`}
          style={{ left: `${left * 100}%`, top: `${(cy(active.revenue) / CH) * 100}%` }}
        >
          {`No. ${active.number} · ${money(active.revenue)} a month`}
        </span>
      </div>

      <div aria-hidden className="relative mt-3 h-4 font-mono text-[10.5px] text-ink-400">
        {YEAR_TICKS.map((year, i) => (
          <span
            key={year}
            className={`absolute top-0 whitespace-nowrap ${i === 0 ? "" : i === YEAR_TICKS.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${(cx(year * 12) / CW) * 100}%` }}
          >
            {year === 0 ? "Charter" : `Year ${year}`}
          </span>
        ))}
      </div>

      <p className="mt-6 max-w-[64ch] text-[14px] leading-6 text-ink-600">
        At 40% a year, the first ten years barely leave the baseline next to the second ten. That is
        what compounding looks like when nobody gets tired of the Goal.
      </p>
    </figure>
  );
}

/* -------------------------------------------------------------------------
   Tabs
------------------------------------------------------------------------- */

function LetterTabs({ index, onPick }: { index: number; onPick: (index: number) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Letters to the board"
      onKeyDown={(event) => {
        const next = {
          ArrowRight: (index + 1) % LETTERS.length,
          ArrowLeft: (index - 1 + LETTERS.length) % LETTERS.length,
          Home: 0,
          End: LETTERS.length - 1,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        onPick(next);
        document.getElementById(`letter-tab-${LETTERS[next].number}`)?.focus();
      }}
      className="scrollbar-none -mx-5 mt-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:grid sm:grid-cols-5 sm:overflow-visible sm:px-0"
    >
      {LETTERS.map((item, i) => {
        const selected = i === index;
        return (
          <button
            key={item.number}
            type="button"
            role="tab"
            id={`letter-tab-${item.number}`}
            aria-selected={selected}
            aria-controls="letter-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => onPick(i)}
            className={`flex min-w-[9.5rem] shrink-0 flex-col items-start rounded-2xl border px-4 py-3 text-left transition-colors duration-200 sm:min-w-0 ${
              selected
                ? "border-ink bg-ink text-white"
                : "border-line bg-paper-raised text-ink hover:border-line-strong"
            }`}
          >
            <span className="font-display text-[1.05rem] leading-tight tracking-[-0.02em]">{`No. ${item.number}`}</span>
            <span className={`mt-1 font-mono text-[10.5px] uppercase tracking-[0.1em] ${selected ? "text-white/60" : "text-ink-400"}`}>
              {item.period}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------
   The letter itself
------------------------------------------------------------------------- */

function LetterSheet({
  letter,
  answer,
  onAnswer,
}: {
  letter: Letter;
  answer?: string;
  onAnswer: (label: string) => void;
}) {
  const metrics: { term: string; value: string; note?: string }[] = [
    { term: "Revenue this month", value: money(letter.revenue) },
    {
      term: "Growth on a year ago",
      value: letter.growth === null ? "Not yet" : percent(letter.growth),
      note: letter.growth === null ? "Nothing to compare" : "Goal: 40%",
    },
    { term: "Reserves", value: letter.reserves },
    { term: "People paid", value: letter.peoplePaid.toLocaleString("en-US") },
  ];

  return (
    <article className="overflow-hidden rounded-[1.75rem] border border-line bg-paper-raised shadow-lifted">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-6 py-5 sm:px-10 sm:py-6">
        <div>
          <p className="font-display text-[1.05rem] font-semibold uppercase leading-none tracking-[0.3em] text-ink">
            {COMPANY}
          </p>
          <p className="mt-2 text-[12.5px] text-ink-500">{TAGLINE}</p>
        </div>
        <div className="sm:text-right">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-600">{`Letter to the board · No. ${letter.number}`}</p>
          <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-400">{`${letter.period} · the first of the month`}</p>
        </div>
      </header>

      <GoalProgress roofs={letter.roofs} />

      <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.term} className="flex flex-col-reverse justify-end bg-paper-raised px-6 py-5 sm:px-7">
            <dt className="mt-1.5 text-[12.5px] leading-5 text-ink-500">
              {metric.term}
              {metric.note && <span className="block font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-400">{metric.note}</span>}
            </dt>
            <dd className="font-display text-[1.6rem] leading-none tracking-[-0.035em] text-ink tabular sm:text-[1.85rem]">
              {metric.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="px-6 py-9 sm:px-10 sm:py-11">
        <p className="font-display text-[1.4rem] leading-tight tracking-[-0.025em] text-ink">{`To the board of ${COMPANY},`}</p>
        <div className="mt-5 max-w-[64ch] space-y-4 text-[16px] leading-[1.75] text-ink-700 sm:text-[16.5px]">
          {letter.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="mt-9 flex flex-wrap items-center justify-between gap-x-6 gap-y-5">
          <div className="flex items-center gap-3.5">
            <Avatar initials={CEO.initials} size="md" />
            <div>
              <p className="font-display text-[1.15rem] leading-tight tracking-[-0.02em] text-ink">{CEO.person}</p>
              <p className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-500">{`${CEO.title}, ${COMPANY}`}</p>
            </div>
          </div>
          <p className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-600">
            <ShieldCheck aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink" strokeWidth={1.8} />
            {"Every figure checked by the board's auditor"}
          </p>
        </div>
      </div>

      {letter.decision ? (
        <DecisionForBoard decision={letter.decision} letter={letter.number} answer={answer} onAnswer={onAnswer} />
      ) : (
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-6 py-6 sm:px-10">
          <StateTag state="run">No Decisions</StateTag>
          <span className="text-[14.5px] text-ink-600">Nothing this month needed the board.</span>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-6 py-4 text-[13px] text-ink-500 sm:px-10">
        <span>
          {"Decisions the executive team made this month without the board, each with its reason on record: "}
          <span className="font-mono text-ink tabular">{letter.decidedWithoutYou.toLocaleString("en-US")}</span>
        </span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">Illustrative · nothing is sent</span>
      </footer>
    </article>
  );
}

/**
 * The Goal's own measure, before revenue or anything else: what a letter
 * reports first tells the board what the company is really for.
 */
function GoalProgress({ roofs }: { roofs: number }) {
  const met = roofs >= GOAL_ROOFS;
  return (
    <div className="border-b border-line px-6 py-5 sm:px-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-500">Toward the Goal</p>
        <p className="flex items-baseline gap-2.5">
          <span className="font-display text-[1.6rem] leading-none tracking-[-0.035em] text-ink tabular sm:text-[1.85rem]">
            {roofs.toLocaleString("en-US")}
          </span>
          <span className="text-[13.5px] text-ink-500">
            {met ? "roofs · Goal met" : `of ${GOAL_ROOFS.toLocaleString("en-US")} roofs`}
          </span>
        </p>
      </div>
      <div aria-hidden className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
        <div
          className="h-full min-w-[6px] rounded-full bg-ink"
          style={{ width: `${Math.min(roofs / GOAL_ROOFS, 1) * 100}%` }}
        />
      </div>
    </div>
  );
}

function DecisionForBoard({
  decision,
  letter,
  answer,
  onAnswer,
}: {
  decision: BoardDecision;
  letter: number;
  answer?: string;
  onAnswer: (label: string) => void;
}) {
  const id = useId();
  return (
    <div className="border-t border-line px-6 py-8 sm:px-10 sm:py-9">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StateTag state="decision">Decision for the board</StateTag>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-400">{`Options written by ${CEO.person}`}</span>
      </div>
      <p id={`${id}-question`} className="mt-5 max-w-[30ch] text-balance font-display text-[1.55rem] leading-[1.15] tracking-[-0.03em] text-ink sm:text-[1.8rem]">
        {decision.question}
      </p>
      <p className="mt-3 max-w-[64ch] text-[14.5px] leading-6 text-ink-600">{decision.context}</p>

      <div role="radiogroup" aria-labelledby={`${id}-question`} className="mt-6 grid gap-2 md:grid-cols-3">
        {decision.options.map((option) => {
          const picked = answer === option.label;
          return (
            <label
              key={option.label}
              className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-4 transition-colors duration-200 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${
                picked ? "border-ink bg-ink text-white" : "border-line bg-paper text-ink hover:border-line-strong hover:bg-white"
              }`}
            >
              <input
                type="radio"
                name={`letter-${letter}-decision`}
                value={option.label}
                checked={picked}
                onChange={() => onAnswer(option.label)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                  picked ? "border-white" : "border-ink-300"
                }`}
              >
                {picked && <span className="h-2 w-2 rounded-full bg-white" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium">{option.label}</span>
                <span className={`mt-1 block text-[13.5px] leading-5 ${picked ? "text-white/70" : "text-ink-500"}`}>
                  {option.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <p role="status" className="mt-4 min-h-[1.5rem] text-[13.5px] leading-6 text-ink-600">
        {answer
          ? `Recorded: "${answer}". ${CEO.person} plans around the board's answer and reports on it in the next letter.`
          : "Only an owner can answer this one. The company decides everything else on its own."}
      </p>
    </div>
  );
}
