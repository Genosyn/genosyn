import { useMemo, useRef, useState } from "react";
import { useReveal } from "@/components/Reveal";
import {
  ARRIVAL,
  APPROVALS_WAITING,
  DECISIONS_WAITING,
  FIRST_RUN,
  LAST_OVERNIGHT_END,
  LANES,
  OVERNIGHT,
  WAITING,
  runMinutes,
  spell,
  type FlatEvent,
} from "@/lib/night";
import { Avatar, Container, DEPT_DOT, DEPT_LABEL, Em, NightPanel, SectionHead, StateTag, clock } from "@/sections/Kit";

const pct = (hours: number) => `${(hours / 24) * 100}%`;

/** The whole sample Tuesday, midnight to midnight, one lane per AI Employee. */
export function Shift() {
  const stats = useReveal<HTMLDListElement>(0, 90);
  return (
    <NightPanel id="shift" dawn={0.55}>
      <Container className="py-20 sm:py-24 lg:py-28">
        <SectionHead
          night
          kicker="The whole shift"
          title={
            <>
              {`${spell(OVERNIGHT.length).replace(/^./, (c) => c.toUpperCase())} Runs before anyone`}{" "}
              <Em tone="night">signed in.</Em>
            </>
          }
          lede="Seven AI Employees worked the same Tuesday. Every bar is a Run: it starts when the Run did and is as long as it took. Everything left of 09:30 happened while nobody was awake."
        />

        <dl ref={stats} className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 sm:grid-cols-3">
          <Stat value={String(OVERNIGHT.length)} label={`Runs finished between ${clock(FIRST_RUN)} and ${clock(LAST_OVERNIGHT_END)}`} />
          <Stat value="0" label="Members signed in while they ran" />
          <Stat
            value={String(WAITING.length)}
            label={`Waited for a person: ${DECISIONS_WAITING} Decisions and ${APPROVALS_WAITING} Approval`}
            accent
          />
        </dl>

        <div className="mt-6 hidden md:block">
          <Chart />
        </div>
        <div className="mt-6 md:hidden">
          <Log />
        </div>

        <p className="mt-5 text-[12px] leading-5 text-night-faint">
          A sample company, drawn to the shape of a real day on a small roster — not an exported log.
        </p>
      </Container>
    </NightPanel>
  );
}

function Stat({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`px-6 py-6 sm:px-7 sm:py-7 ${accent ? "bg-white text-ink" : "bg-night-raised/80 text-white"}`}>
      <dt className="sr-only">{label}</dt>
      <dd>
        <span className="block font-display text-[3.6rem] leading-none tracking-[-0.04em] tabular">{value}</span>
        <span className={`mt-3 block max-w-[26ch] text-[13.5px] leading-5 ${accent ? "text-ink-600" : "text-night-muted"}`}>
          {label}
        </span>
      </dd>
    </div>
  );
}

type Bar = FlatEvent & { index: number };

function Chart() {
  const bars = useMemo<Bar[]>(
    () =>
      LANES.flatMap(({ events, ...lane }) => events.map((event) => ({ ...event, ...lane }))).map(
        (event, index) => ({ ...event, index }),
      ),
    [],
  );
  const [active, setActive] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const plot = useRef<HTMLDivElement>(null);
  const current = active === null ? null : bars[active];

  const move = (index: number) => {
    const next = (index + bars.length) % bars.length;
    setFocus(next);
    setActive(next);
    plot.current?.querySelector<HTMLButtonElement>(`[data-bar="${next}"]`)?.focus();
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-white/10 bg-night-raised/70">
      <div
        ref={plot}
        role="group"
        aria-label="One Tuesday, midnight to midnight: every Run and every stop, by AI Employee"
        onKeyDown={(event) => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
          if (step === undefined) return;
          event.preventDefault();
          move(focus + step);
        }}
        className="relative px-6 pb-4 pt-10"
      >
        <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-4">
          <div />
          <div className="relative">
            <span
              className="absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-full bg-white px-2.5 py-1 font-mono text-[10px] uppercase leading-none tracking-[0.1em] text-ink"
              style={{ left: pct(ARRIVAL) }}
            >
              09:30 · You sign in
            </span>
          </div>

          {LANES.map((lane) => (
            <div key={lane.person} className="contents">
              <div className="flex h-12 items-center gap-2.5 border-b border-white/[0.06]">
                <Avatar initials={lane.initials} dept={lane.dept} size="sm" night />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] leading-4 text-white">{lane.person}</span>
                  <span className="block truncate text-[11px] leading-4 text-night-faint">{DEPT_LABEL[lane.dept]}</span>
                </span>
              </div>
              <div className="relative h-12 border-b border-white/[0.06]">
                {[3, 6, 9, 12, 15, 18, 21].map((hour) => (
                  <span
                    key={hour}
                    aria-hidden
                    className={`absolute inset-y-0 w-px ${hour % 6 === 0 ? "bg-white/[0.08]" : "bg-white/[0.04]"}`}
                    style={{ left: pct(hour) }}
                  />
                ))}
                {/* Everything before the first sign-in sits on a slightly darker night. */}
                <div className="absolute inset-y-0 left-0 bg-black/20" style={{ width: pct(ARRIVAL) }} />
                {bars
                  .filter((bar) => bar.person === lane.person)
                  .map((bar) => (
                    <BarButton
                      key={bar.index}
                      bar={bar}
                      active={active === bar.index}
                      tabIndex={focus === bar.index ? 0 : -1}
                      onEnter={() => setActive(bar.index)}
                      onLeave={() => setActive(null)}
                    />
                  ))}
              </div>
            </div>
          ))}

          <div />
          <div className="relative mt-2 flex justify-between font-mono text-[10px] text-night-faint">
            {["00:00", "06:00", "12:00", "18:00", "24:00"].map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>

        {/* The 09:30 line crosses every lane. */}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-10 top-10 w-px bg-white/60"
          style={{ left: `calc(1.5rem + 9.5rem + 1rem + (100% - 3rem - 10.5rem) * ${ARRIVAL / 24})` }}
        />
      </div>

      <div
        aria-live="polite"
        className="flex min-h-[3.5rem] flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.07] bg-black/20 px-6 py-3"
      >
        {current ? (
          <>
            <span className="font-mono text-[12px] text-white tabular">
              {current.hours ? `${clock(current.at)}–${clock(current.at + current.hours)}` : clock(current.at)}
            </span>
            <span className="inline-flex items-center gap-2 text-[12px] text-night-muted">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DEPT_DOT[current.dept]}`} />
              {`${current.person} · ${DEPT_LABEL[current.dept]}`}
            </span>
            <span className="text-[14px] text-white">{current.label}</span>
            {current.state === "run" ? (
              <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.1em] text-night-faint">
                {`${runMinutes(current)} min`}
              </span>
            ) : (
              <StateTag state={current.state} night className="ml-auto">
                {current.state === "decision" ? "Decision" : "Approval"}
              </StateTag>
            )}
          </>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-night-faint">
            Hover or use the arrow keys to read any Run
          </span>
        )}
      </div>
    </div>
  );
}

function BarButton({
  bar,
  active,
  tabIndex,
  onEnter,
  onLeave,
}: {
  bar: Bar;
  active: boolean;
  tabIndex: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const label = `${bar.hours ? `${clock(bar.at)} to ${clock(bar.at + bar.hours)}` : clock(bar.at)}, ${bar.person}, ${bar.label}`;
  const handlers = {
    "data-bar": bar.index,
    tabIndex,
    "aria-label": label,
    onPointerEnter: onEnter,
    onPointerLeave: onLeave,
    onFocus: onEnter,
    onBlur: onLeave,
  };

  if (bar.state !== "run") {
    return (
      <button
        type="button"
        {...handlers}
        className={`absolute top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 transition-transform duration-200 ${
          bar.state === "decision" ? "bg-white ring-white/15" : "border-2 border-white bg-night ring-white/10"
        } ${active ? "scale-125" : ""}`}
        style={{ left: pct(bar.at) }}
      />
    );
  }
  const overnight = bar.at < ARRIVAL;
  return (
    <button
      type="button"
      {...handlers}
      className={`absolute top-1/2 h-5 min-w-[5px] -translate-y-1/2 rounded-md transition-colors duration-200 ${
        active ? "bg-white" : overnight ? "bg-white/55 hover:bg-white/80" : "bg-white/20 hover:bg-white/35"
      }`}
      style={{ left: pct(bar.at), width: pct(bar.hours ?? 0.25) }}
    />
  );
}

/** Below `md`, the same night as text: overnight summarised, then the stops. */
function Log() {
  return (
    <div className="overflow-hidden rounded-3xl border border-white/10 bg-night-raised/70">
      <ol className="divide-y divide-white/[0.06]">
        {OVERNIGHT.slice(-5)
          .reverse()
          .map((event) => (
            <li key={`${event.person}-${event.at}`} className="flex gap-3 px-5 py-3.5">
              <span className="w-11 shrink-0 pt-0.5 font-mono text-[11.5px] text-night-faint">{clock(event.at)}</span>
              <span className="min-w-0">
                <span className="block text-[12px] text-night-muted">{`${event.person} · ${DEPT_LABEL[event.dept]}`}</span>
                <span className="mt-0.5 block text-[14px] leading-5 text-white">{event.label}</span>
              </span>
            </li>
          ))}
      </ol>
      <div className="flex items-center gap-3 border-y border-white/10 bg-white/[0.06] px-5 py-2.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-white">09:30 · You sign in</span>
      </div>
      <ul className="divide-y divide-white/[0.06]">
        {WAITING.map((item) => (
          <li key={item.label} className="flex items-start gap-3 px-5 py-3.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] leading-5 text-white">{item.label}</span>
              <span className="mt-0.5 block text-[12px] text-night-muted">{`${item.person} · ${DEPT_LABEL[item.dept]}`}</span>
            </span>
            <StateTag state={item.state} night>
              {item.state === "decision" ? "Decision" : "Approval"}
            </StateTag>
          </li>
        ))}
      </ul>
    </div>
  );
}
