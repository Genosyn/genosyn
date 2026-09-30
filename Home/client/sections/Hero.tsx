import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RotateCcw, Sunrise } from "lucide-react";
import { SIGN_UP_URL } from "@/lib/constants";
import {
  ARRIVAL,
  ALL_EVENTS,
  COMPANY,
  LAST_OVERNIGHT_END,
  LANES,
  OVERNIGHT,
  WAITING,
  runMinutes,
  spell,
  type FlatEvent,
} from "@/lib/night";
import { Avatar, Button, CopyCommand, DEPT_LABEL, NightPanel, StateTag, clock } from "@/sections/Kit";

export const INSTALL_COMMAND = "curl -fsSL https://genosyn.com/install.sh | bash";

/** The moment the prerendered page shows: the 04:05 reconciliation is running. */
const START = 4.08;
/** How long one hour of the night lasts on screen. */
const HOUR_MS = 820;
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
    <NightPanel dawn={dawn} className="pb-6 sm:pb-8">
      <div ref={target} className="mx-auto w-full max-w-site px-5 pt-12 sm:px-8 sm:pt-16 lg:px-12 lg:pt-[4.5rem]">
        <div className="grid items-center gap-x-12 gap-y-14 lg:grid-cols-[minmax(0,1.14fr)_minmax(0,0.86fr)] xl:gap-x-16">
          <div className="min-w-0">
            <p className="kicker inline-flex flex-wrap items-center gap-x-3 gap-y-2 text-night-muted">
              <span aria-hidden className="h-px w-6 bg-white/50" />
              Open source
              <span aria-hidden className="hidden text-night-faint sm:inline">/</span>
              <span className="hidden sm:inline">Self-host or Cloud</span>
              <span aria-hidden className="text-night-faint">/</span>
              <span className="normal-case tracking-[0.06em]">{`v${__APP_VERSION__}`}</span>
            </p>

            <h1 className="mt-7 font-display text-[clamp(2.8rem,5.6vw,5.15rem)] leading-[0.97] tracking-[-0.035em] text-white">
              Wake up to work <br className="hidden sm:block" />
              <em className="italic">already&nbsp;done.</em>
            </h1>

            <p className="mt-7 max-w-[34rem] text-pretty text-[1.0625rem] leading-[1.6] text-night-muted sm:text-[1.1875rem]">
              Genosyn gives your company AI Employees with real roles. They work their Routines
              through the night, and leave you only the decisions that need a person.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Button href={SIGN_UP_URL} variant="paper" size="lg" arrow>
                Start free on Cloud
              </Button>
              <Button href="/docs" variant="outline-night" size="lg">
                Read the docs
              </Button>
            </div>

            <div className="mt-7 max-w-[33rem]">
              <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-night-faint">
                Or self-host in one command
              </p>
              <CopyCommand command={INSTALL_COMMAND} night />
            </div>
          </div>

          <Console now={now} phase={phase} onReplay={replay} />
        </div>

        <Horizon now={now} />
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
      <p className="font-display text-[1.9rem] leading-[1.08] tracking-[-0.02em] text-white sm:text-[2.2rem]">
        {`${capitalise(spell(OVERNIGHT.length))} Runs finished while you slept.`}{" "}
        <em className="italic text-white/55">{`${capitalise(spell(WAITING.length))} need you.`}</em>
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
        href="#shift"
        className="group mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-white/85 hover:text-white"
      >
        See the whole shift
        <ArrowRight aria-hidden className="nudge h-3.5 w-3.5" />
      </a>
    </div>
  );
}

/* -------------------------------------------------------------------------
   The horizon: the same night as a 24-hour strip along the bottom edge.
------------------------------------------------------------------------- */

const pct = (hours: number) => `${(hours / 24) * 100}%`;

function Horizon({ now }: { now: number }) {
  return (
    <div aria-hidden className="relative mt-16 hidden select-none sm:block lg:mt-14">
      <div className="relative h-14">
        <div className="hour-grid hour-grid-night absolute inset-x-0 bottom-5 top-2" />
        {/* Lanes collapse into one strip: each Run is a sliver at its start time. */}
        {LANES.map((lane, laneIndex) =>
          lane.events.map((event) => {
            const reached = event.at <= now;
            const top = 8 + laneIndex * 4;
            if (event.state !== "run") {
              return (
                <span
                  key={`${lane.person}-${event.at}`}
                  className={`absolute h-2 w-2 -translate-x-1/2 rounded-full transition-opacity duration-500 ${
                    event.state === "decision" ? "bg-white" : "border border-white bg-night"
                  } ${now >= ARRIVAL ? "opacity-100" : "opacity-25"}`}
                  style={{ left: pct(event.at), top: 18 }}
                />
              );
            }
            return (
              <span
                key={`${lane.person}-${event.at}`}
                className={`absolute h-[3px] rounded-full transition-colors duration-500 ${
                  reached ? "bg-white/85" : "bg-white/[0.12]"
                }`}
                style={{ left: pct(event.at), width: pct(event.hours ?? 0.25), top }}
              />
            );
          }),
        )}
        {/* Now. */}
        <span className="absolute bottom-5 top-0 w-px bg-white shadow-glow" style={{ left: pct(Math.min(now, ARRIVAL)) }} />
        <span className="absolute bottom-5 top-0 w-px bg-white/30" style={{ left: pct(ARRIVAL) }} />
        <div className="absolute inset-x-0 bottom-0 flex h-4 items-end justify-between font-mono text-[10px] text-night-faint">
          {["00:00", "06:00", "12:00", "18:00", "24:00"].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <span
          className="absolute -top-5 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.12em] text-white/70"
          style={{ left: pct(ARRIVAL) }}
        >
          09:30 · You sign in
        </span>
      </div>
      <p className="mt-3 text-[11px] text-night-faint">
        {`${ALL_EVENTS.filter((event) => event.state === "run").length} Runs across seven departments on one sample Tuesday. Each sliver starts when its Run did and lasts as long as it took.`}
      </p>
    </div>
  );
}
