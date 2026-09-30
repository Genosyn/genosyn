import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RotateCcw, Sunrise } from "lucide-react";
import { INSTALL_DOCS_PATH } from "@/lib/constants";
import {
  ARRIVAL,
  COMPANY,
  LAST_OVERNIGHT_END,
  LANES,
  OVERNIGHT,
  WAITING,
  runMinutes,
  spell,
  type FlatEvent,
  type Lane,
  type NightEvent,
} from "@/lib/night";
import { Avatar, Button, CopyCommand, DEPT_DOT, DEPT_LABEL, NightPanel, StateTag, clock } from "@/sections/Kit";

export const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

/** The moment the prerendered page shows: the 04:05 reconciliation is running. */
const START = 4.08;
/**
 * How long one hour of the night lasts on screen: ~11s from `START` to the
 * morning, slow enough to read each Run as it lands in the feed.
 */
const HOUR_MS = 2000;
const FEED_ROWS = 5;

type Phase = "night" | "morning";

const capitalise = (text: string) => text.replace(/^./, (c) => c.toUpperCase());

/**
 * Plays the night forward from `START` to 09:30 once the hero is on screen.
 * Reduced-motion readers skip straight to the morning.
 */
function useNight() {
  const [now, setNow] = useState(START);
  const [phase, setPhase] = useState<Phase>("night");
  const frame = useRef<number>();
  const target = useRef<HTMLDivElement>(null);

  const play = useCallback((from: number, hourMs: number) => {
    cancelAnimationFrame(frame.current ?? 0);
    setPhase("night");
    setNow(from);
    const started = performance.now();
    let last = 0;
    const tick = (time: number) => {
      const next = from + (time - started) / hourMs;
      if (next >= ARRIVAL) {
        setNow(ARRIVAL);
        setPhase("morning");
        return;
      }
      // ~30 updates a second is plenty for a clock that is a blur anyway.
      if (time - last > 33) {
        last = time;
        setNow(next);
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setNow(ARRIVAL);
      setPhase("morning");
      return;
    }
    const node = target.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      play(START, HOUR_MS);
      return;
    }
    let started = false;
    let delay: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!started && entries.some((entry) => entry.isIntersecting)) {
          started = true;
          observer.disconnect();
          // A beat of stillness first, so the page reads before it moves.
          delay = setTimeout(() => play(START, HOUR_MS), 700);
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      clearTimeout(delay);
      cancelAnimationFrame(frame.current ?? 0);
    };
  }, [play]);

  const replay = useCallback(() => play(0, HOUR_MS * 0.8), [play]);

  return { now, phase, replay, target };
}

export function Hero() {
  const { now, phase, replay, target } = useNight();
  // Morning light reaches the horizon as the clock approaches 09:30.
  const progress = Math.min(1, now / ARRIVAL);
  const dawn = 0.15 + 0.85 * Math.pow(progress, 1.6);

  return (
    <NightPanel dawn={dawn} className="pb-6 sm:pb-8 lg:pb-12">
      <div ref={target} className="mx-auto w-full max-w-site px-5 pt-12 sm:px-8 sm:pt-16 lg:px-12 lg:pt-[4.5rem]">
        <div className="grid items-center gap-x-12 gap-y-14 lg:grid-cols-[minmax(0,1.14fr)_minmax(0,0.86fr)] xl:gap-x-16">
          <div className="min-w-0">
            <p className="kicker inline-flex flex-wrap items-center gap-x-3 gap-y-2 text-night-muted">
              <span aria-hidden className="h-px w-6 bg-white/50" />
              Open source
              <span aria-hidden className="hidden text-night-faint sm:inline">/</span>
              <span className="hidden sm:inline">Apache 2.0</span>
              <span aria-hidden className="text-night-faint">/</span>
              <span className="normal-case tracking-[0.06em]">{`v${__APP_VERSION__}`}</span>
            </p>

            <h1 className="mt-7 font-display text-[clamp(2.6rem,5.2vw,4.65rem)] leading-[0.98] tracking-[-0.048em] text-white">
              Your company <br className="hidden sm:block" />
              can now run <br className="hidden sm:block" />
              automatically.
            </h1>

            <p className="mt-7 max-w-[34rem] text-pretty text-[1.0625rem] leading-[1.6] text-night-muted sm:text-[1.1875rem]">
              Genosyn gives your company AI Employees with real roles. They work their Routines
              through the night, and leave you only the decisions that need a person.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button href={INSTALL_DOCS_PATH} variant="paper" size="lg" arrow>
                Install Genosyn
              </Button>
              <Button href="/docs" variant="outline-night" size="lg">
                Read the docs
              </Button>
            </div>

            <div className="mt-7 max-w-[33rem]">
              <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-night-faint">
                Or install in one command
              </p>
              <CopyCommand command={INSTALL_COMMAND} night />
            </div>
          </div>

          <Console now={now} phase={phase} onReplay={replay} />
        </div>

        <NightChart now={now} phase={phase} />
      </div>
    </NightPanel>
  );
}

/* -------------------------------------------------------------------------
   The console: the night as a feed, then the morning as a summary.
------------------------------------------------------------------------- */

function Console({ now, phase, onReplay }: { now: number; phase: Phase; onReplay: () => void }) {
  const started = OVERNIGHT.filter((event) => event.at <= now);
  const finished = started.filter((event) => event.at + (event.hours ?? 0.25) <= now);
  const feed = [...started].reverse().slice(0, FEED_ROWS);
  const onShift = new Set(started.map((event) => event.person)).size;

  return (
    <div className="relative min-w-0">
      {/* A faint halo so the card lifts off the night without a border shouting. */}
      <div aria-hidden className="pointer-events-none absolute -inset-8 rounded-[2.5rem] bg-white/[0.035] blur-2xl" />
      <div className="relative overflow-hidden rounded-[1.6rem] border border-white/[0.09] bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-float">
        <p className="sr-only">
          {`A sample night at ${COMPANY}: ${OVERNIGHT.length} Runs finished between ${clock(OVERNIGHT[0].at)} and ${clock(
            LAST_OVERNIGHT_END,
          )} while nobody was signed in, and ${WAITING.length} items waited for a person.`}
        </p>

        {/* Header: the company, the clock, and how far the night has got. */}
        <div className="border-b border-white/[0.07] px-5 pb-5 pt-5 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <span className="inline-flex min-w-0 items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-night-muted">
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${phase === "morning" ? "bg-white" : "animate-soft-pulse bg-white"}`}
              />
              <span className="truncate">{`${COMPANY} · Tuesday`}</span>
            </span>
            <span className="hidden shrink-0 rounded-full border border-white/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-night-faint sm:inline">
              Sample night
            </span>
          </div>

          <div aria-hidden className="mt-5 flex items-end justify-between gap-4">
            <span className="font-mono text-[2.9rem] font-light leading-none tracking-[-0.05em] text-white tabular sm:text-[3.4rem]">
              {clock(now)}
            </span>
            <span className="pb-1 text-right text-[12px] leading-5 text-night-muted">
              {phase === "morning" ? (
                <span className="inline-flex items-center gap-1.5 text-white">
                  <Sunrise className="h-3.5 w-3.5" />
                  You sign in
                </span>
              ) : (
                <>
                  <span className="text-white">{onShift}</span> AI Employees on shift
                  <br />
                  <span className="text-white">0</span> Members signed in
                </>
              )}
            </span>
          </div>

          <div aria-hidden className="relative mt-5 h-[3px] rounded-full bg-white/[0.08]">
            <div
              className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-white/90"
              style={{ transform: `scaleX(${Math.min(1, now / ARRIVAL)})` }}
            />
            <span className="absolute -top-1 right-0 h-[11px] w-px bg-white/40" />
          </div>
          <div aria-hidden className="mt-2 flex justify-between font-mono text-[10px] text-night-faint">
            <span>00:00</span>
            <span>09:30</span>
          </div>
        </div>

        {phase === "night" ? (
          <ol aria-hidden className="min-h-[21.5rem] divide-y divide-white/[0.06] sm:min-h-[22.5rem]">
            {feed.map((event) => (
              <FeedRow key={`${event.person}-${event.at}`} event={event} now={now} />
            ))}
          </ol>
        ) : (
          <Morning />
        )}

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-3 sm:px-6">
          <span aria-hidden className="hidden font-mono text-[11px] uppercase tracking-[0.1em] text-night-faint sm:inline">
            {phase === "morning"
              ? `${OVERNIGHT.length} Runs · ${clock(OVERNIGHT[0].at)}–${clock(LAST_OVERNIGHT_END)}`
              : `${finished.length} of ${OVERNIGHT.length} Runs finished`}
          </span>
          <button
            type="button"
            onClick={onReplay}
            className="-ml-3 inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12px] font-medium text-night-muted transition-colors hover:bg-white/[0.08] hover:text-white sm:ml-0"
          >
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
            Replay the night
          </button>
        </div>
      </div>
    </div>
  );
}

function FeedRow({ event, now }: { event: FlatEvent; now: number }) {
  const running = now < event.at + (event.hours ?? 0.25);
  return (
    <li className={`feed-in flex gap-3.5 px-5 py-3.5 sm:px-6 ${running ? "working bg-white/[0.025]" : ""}`}>
      <span className="w-11 shrink-0 pt-0.5 font-mono text-[11.5px] text-night-faint tabular">{clock(event.at)}</span>
      <Avatar initials={event.initials} dept={event.dept} size="sm" night />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[12px] text-night-muted">
            <span className="text-white/90">{event.person}</span>
            {` · ${DEPT_LABEL[event.dept]}`}
          </span>
          {running ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-white">
              <span aria-hidden className="h-1 w-1 animate-soft-pulse rounded-full bg-white" />
              Running
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-night-faint">
              <Check className="h-3 w-3 text-moss-400" />
              {`${runMinutes(event)}m`}
            </span>
          )}
        </span>
        <span className="mt-1 block text-[14px] leading-5 text-white">{event.label}</span>
      </span>
    </li>
  );
}

function Morning() {
  return (
    <div className="settle min-h-[21.5rem] px-5 pb-5 pt-6 sm:min-h-[22.5rem] sm:px-6">
      <p className="font-display text-[1.7rem] leading-[1.1] tracking-[-0.035em] text-white sm:text-[1.95rem]">
        {`${capitalise(spell(OVERNIGHT.length))} Runs finished while you slept.`}{" "}
        <span className="text-white/50">{`${capitalise(spell(WAITING.length))} need you.`}</span>
      </p>
      <ul className="mt-5 space-y-2">
        {WAITING.map((item) => (
          <li
            key={item.label}
            className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3"
          >
            <Avatar initials={item.initials} dept={item.dept} size="sm" night />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] leading-5 text-white">{item.label}</span>
              <span className="mt-1 block text-[12px] text-night-muted">{`${item.person} · ${item.role}`}</span>
            </span>
            <StateTag state={item.state} night className="mt-0.5">
              {item.state === "decision" ? "Decision" : "Approval"}
            </StateTag>
          </li>
        ))}
      </ul>
      <a
        href="#guardrails"
        className="group mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/85 hover:text-white"
      >
        Why these three waited
        <ArrowRight aria-hidden className="nudge h-3.5 w-3.5" />
      </a>
    </div>
  );
}

/* -------------------------------------------------------------------------
   The night chart: every lane of the same night, filling in as the clock
   plays, with the morning — and what is waiting in it — to the right.
------------------------------------------------------------------------- */

/** The chart shows the night and the morning after it: 00:00 to 14:00. */
const CHART_END = 14;
const TICKS = [0, 2, 4, 6, 8, 10, 12, 14];
const at = (hours: number) => `${(hours / CHART_END) * 100}%`;

type Hovered = { event: NightEvent; lane: Lane; row: number };

function NightChart({ now, phase }: { now: number; phase: Phase }) {
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const finished = OVERNIGHT.filter((event) => event.at + (event.hours ?? 0.25) <= now).length;
  const playhead = Math.min(now, ARRIVAL);

  return (
    <div
      aria-hidden
      className="relative mt-14 hidden select-none rounded-[1.6rem] border border-white/[0.08] bg-gradient-to-b from-white/[0.045] to-white/[0.015] p-5 md:block lg:mt-16 lg:p-7"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex items-baseline gap-4">
          <span className="text-[15px] font-semibold tracking-[-0.01em] text-white">{`The night at ${COMPANY}`}</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-night-faint">
            {phase === "morning" ? `${OVERNIGHT.length} Runs · ${WAITING.length} waiting` : `${finished} of ${OVERNIGHT.length} Runs finished`}
          </span>
        </div>
        <ul className="flex items-center gap-5 text-[12px] text-night-muted">
          <li className="flex items-center gap-2">
            <span className="h-2 w-5 rounded-full bg-white/85" />
            Run
          </li>
          <li className="flex items-center gap-2">
            <span className="h-2 w-5 rounded-full border border-dashed border-white/35" />
            Scheduled
          </li>
          <li className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-white" />
            Decision
          </li>
          <li className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-white" />
            Approval
          </li>
        </ul>
      </div>

      <div className="mt-6 grid grid-cols-[8.75rem_minmax(0,1fr)] gap-x-5">
        {/* Lane labels */}
        <div className="pt-8">
          {LANES.map((lane) => (
            <div key={lane.person} className="flex h-8 items-center gap-2.5">
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-night-high font-mono text-[8px] text-white ring-1 ring-white/10">
                {lane.initials}
                <span className={`absolute -bottom-px -right-px h-1.5 w-1.5 rounded-full ring-1 ring-night ${DEPT_DOT[lane.dept]}`} />
              </span>
              <span className="truncate text-[12.5px] text-white/85">{lane.person}</span>
              <span className="truncate text-[11px] text-night-faint">{DEPT_LABEL[lane.dept]}</span>
            </div>
          ))}
        </div>

        {/* Plot */}
        <div className="relative pt-8" onMouseLeave={() => setHovered(null)}>
          {/* Morning: everything after the first sign-in sits on a lighter ground. */}
          <div
            className="absolute bottom-0 right-0 top-8 rounded-r-lg bg-white/[0.035]"
            style={{ left: at(ARRIVAL) }}
          />
          <span
            className="absolute top-8 mt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-night-faint"
            style={{ right: "0.625rem" }}
          >
            Morning
          </span>

          {/* Hour lines */}
          {TICKS.slice(1, -1).map((tick) => (
            <span key={tick} className="absolute bottom-0 top-8 w-px bg-white/[0.05]" style={{ left: at(tick) }} />
          ))}

          {/* Lanes */}
          {LANES.map((lane, row) => (
            <div key={lane.person} className="relative h-8">
              <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/[0.04]" />
              {lane.events
                .filter((event) => event.at < CHART_END)
                .map((event) => (
                  <Mark
                    key={`${lane.person}-${event.at}`}
                    event={event}
                    now={now}
                    morning={phase === "morning"}
                    active={hovered?.event === event}
                    onEnter={() => setHovered({ event, lane, row })}
                  />
                ))}
            </div>
          ))}

          {/* The first sign-in */}
          <span className="absolute bottom-0 top-8 w-px bg-white/25" style={{ left: at(ARRIVAL) }} />

          {/* Now */}
          <span
            className="absolute bottom-0 top-2 w-px bg-white shadow-[0_0_12px_rgb(255_255_255/0.6)]"
            style={{ left: at(playhead) }}
          />
          <span
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-full bg-white px-2 py-[3px] font-mono text-[10px] font-medium leading-none text-ink"
            style={{ left: at(playhead) }}
          >
            {phase === "morning" ? "09:30 · You sign in" : clock(now)}
          </span>

          {hovered && <Tooltip hovered={hovered} />}
        </div>

        {/* Axis */}
        <div />
        <div className="relative mt-3 h-4 font-mono text-[10px] text-night-faint">
          {TICKS.map((tick, index) => (
            <span
              key={tick}
              className={`absolute top-0 ${index === 0 ? "" : index === TICKS.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
              style={{ left: at(tick) }}
            >
              {clock(tick)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One Run as a bar that fills while it runs, or one stop as a marker. */
function Mark({
  event,
  now,
  morning,
  active,
  onEnter,
}: {
  event: NightEvent;
  now: number;
  morning: boolean;
  active: boolean;
  onEnter: () => void;
}) {
  if (event.state !== "run") {
    const lit = morning;
    return (
      <span
        onMouseEnter={onEnter}
        className={`absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-default rounded-full transition-all duration-500 ${
          event.state === "decision"
            ? lit
              ? "bg-white shadow-[0_0_0_4px_rgb(255_255_255/0.12)]"
              : "bg-white/25"
            : lit
              ? "border-2 border-white bg-night shadow-[0_0_0_4px_rgb(255_255_255/0.08)]"
              : "border-2 border-white/25 bg-night"
        } ${active ? "scale-125" : ""}`}
        style={{ left: at(event.at) }}
      />
    );
  }

  const length = Math.min(event.hours ?? 0.25, CHART_END - event.at);
  const end = event.at + length;
  const scheduled = event.at >= ARRIVAL;
  const fill = scheduled ? 0 : Math.max(0, Math.min(1, (now - event.at) / length));
  const running = fill > 0 && fill < 1;

  return (
    <span
      onMouseEnter={onEnter}
      className={`absolute top-1/2 h-2.5 min-w-[6px] -translate-y-1/2 cursor-default overflow-hidden rounded-full transition-colors duration-300 ${
        scheduled ? "border border-dashed border-white/30" : "bg-white/[0.09]"
      } ${active ? "ring-2 ring-white/40" : ""}`}
      style={{ left: at(event.at), width: at(end - event.at) }}
    >
      {!scheduled && (
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${running ? "bg-white shadow-[0_0_10px_rgb(255_255_255/0.7)]" : "bg-white/85"}`}
          style={{ width: `${fill * 100}%` }}
        />
      )}
    </span>
  );
}

function Tooltip({ hovered }: { hovered: Hovered }) {
  const { event, lane, row } = hovered;
  const left = Math.min(Math.max(event.at / CHART_END, 0.12), 0.82) * 100;
  const timing = event.hours
    ? `${clock(event.at)}–${clock(event.at + event.hours)} · ${runMinutes(event)} min`
    : clock(event.at);
  return (
    <div
      className="pointer-events-none absolute z-20 w-64 rounded-xl border border-white/10 bg-night-high px-3.5 py-3 shadow-float"
      style={{ left: `${left}%`, top: `calc(2rem + ${row * 2}rem - 0.5rem)`, transform: "translate(-50%, -100%)" }}
    >
      <p className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-night-faint">{timing}</p>
      <p className="mt-1.5 text-[13px] leading-5 text-white">{event.label}</p>
      <p className="mt-1 text-[11.5px] text-night-muted">
        {`${lane.person} · ${event.state === "run" ? DEPT_LABEL[lane.dept] : event.state === "decision" ? "Decision" : "Approval"}`}
      </p>
    </div>
  );
}
