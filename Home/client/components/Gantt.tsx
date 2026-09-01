import { useCallback, useMemo, useRef, useState } from "react";
import { Mark, type MarkState } from "@/components/Marks";

/**
 * The 24-hour chart, and the only implementation of it.
 *
 * There were three before this: the hero board, the night-shift strip, and the
 * single-lane rail on a role page. Each had its own copy of the same
 * arithmetic (`left: at/24`, `width: hours/24`), its own hour ruling, its own
 * arrival flag and its own lane heights, and they had already drifted — 2.375
 * rem lanes on one, 1.875rem on another, a 7.5rem owner column against 8.5rem.
 * They are one component now, so a fix to the chart is a fix to the chart.
 *
 * ## What makes it a chart rather than a picture
 *
 * A bar's LEFT EDGE is when the work started and its WIDTH is how long it took.
 * Nothing here is a decorative rectangle. Events with no duration — a Decision,
 * an Approval — are moments, and they are drawn as a mark rather than stretched
 * into a bar they have no claim to.
 *
 * ## Interaction, and why it is a readout rather than a tooltip
 *
 * Hovering a bar does not open a floating card. It fills a READOUT — a fixed
 * field under the chart that always occupies the same space and always shows
 * the same shape of record. That is how an instrument behaves, and it has two
 * practical advantages over a tooltip: it never covers the data it describes,
 * and it does not move, so comparing two bars is a matter of looking at one
 * place twice.
 *
 * Three other affordances:
 *
 *   - **A crosshair** follows a mouse across the plot with the time under it,
 *     so "what was running at 04:20" is answerable by pointing. Mouse only:
 *     on touch there is no hover state to speak of and it would just be a
 *     rectangle that appears when you scroll.
 *   - **Clicking a lane owner isolates that lane.** The other lanes keep their
 *     outlines and lose their fill, so they read as context rather than
 *     vanishing. A bar you cannot see is not a de-emphasised bar, it is a
 *     missing one.
 *   - **Clicking a bar pins it**, so the readout survives the pointer leaving.
 *
 * ## Keyboard
 *
 * The plot is one tab stop with a roving tabindex, not 27 of them. Arrow left
 * and right walk the lane in time order, up and down change lane, Home and End
 * jump to the ends of the day, Escape clears. That is the standard pattern for
 * a composite widget and it keeps the chart from swallowing a keyboard user
 * for half a minute on the way to the install button.
 *
 * The readout is `aria-live="polite"`, so it is also the accessible
 * description: focus a bar and the record is announced. Every page that
 * renders a chart also renders the same events as text below it, which is the
 * real equivalent for anyone not using the chart at all.
 */

export type GanttEvent = {
  lane: string;
  /** Hours past midnight. */
  at: number;
  /** Duration in hours. Absent means a moment, not a zero-length bar. */
  hours?: number;
  label: string;
  state: MarkState;
};

type Props = {
  lanes: string[];
  events: GanttEvent[];
  /** Hour of the arrival rule, e.g. 9.5 for 09:30. Omit to draw none. */
  arrival?: number;
  arrivalLabel?: string;
  night?: boolean;
  /** The line the readout shows when nothing is selected. */
  summary: string;
  ariaLabel: string;
  /** Minimum plot width before the container scrolls rather than reflowing. */
  minWidth?: string;
  className?: string;
};

const pct = (hours: number) => `${(hours / 24) * 100}%`;

export function clock(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function minutes(hours: number): string {
  return `${Math.round(hours * 60)} min`;
}

export function Gantt({
  lanes,
  events,
  arrival,
  arrivalLabel = "You sign in",
  night = false,
  summary,
  ariaLabel,
  minWidth = "54rem",
  className = "",
}: Props) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [isolated, setIsolated] = useState<string | null>(null);
  const [crosshair, setCrosshair] = useState<number | null>(null);

  // Lane-major, then chronological: the order the arrow keys walk, and the
  // order the DOM is in, so focus never jumps somewhere the eye is not.
  const ordered = useMemo(
    () =>
      lanes.flatMap((lane) => events.filter((e) => e.lane === lane).sort((a, b) => a.at - b.at)),
    [lanes, events],
  );

  const shown = pinned ?? active;
  const current = shown === null ? null : ordered[shown];

  const move = useCallback(
    (index: number) => {
      const next = Math.max(0, Math.min(ordered.length - 1, index));
      setActive(next);
      setPinned(next);
      const node = plotRef.current?.querySelector<HTMLButtonElement>(`[data-bar="${next}"]`);
      node?.focus();
    },
    [ordered.length],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (shown === null) return;
    const item = ordered[shown];
    const laneIndex = lanes.indexOf(item.lane);
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(shown + 1),
      ArrowLeft: () => move(shown - 1),
      Home: () => move(0),
      End: () => move(ordered.length - 1),
      Escape: () => {
        setPinned(null);
        setActive(null);
      },
      ArrowDown: () => jumpLane(laneIndex + 1, item.at),
      ArrowUp: () => jumpLane(laneIndex - 1, item.at),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  /** Change lane, landing on whatever was running nearest the same time. */
  function jumpLane(laneIndex: number, at: number) {
    const lane = lanes[Math.max(0, Math.min(lanes.length - 1, laneIndex))];
    let best = -1;
    let bestGap = Infinity;
    ordered.forEach((event, index) => {
      if (event.lane !== lane) return;
      const gap = Math.abs(event.at - at);
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    if (best >= 0) move(best);
  }

  const rule = night ? "border-night-600" : "border-paper-400";
  const quarter = night ? "bg-night-600" : "bg-paper-400";
  const quiet = night ? "text-zinc-400" : "text-zinc-600";

  return (
    <div className={className}>
      <div
        className={`overflow-x-auto border-x border-b ${
          night ? "border-night-600 bg-night-950" : "border-paper-400 bg-paper-50"
        }`}
      >
        <div style={{ minWidth }} className="p-5">
          <div className="grid grid-cols-[minmax(0,1fr)_8.5rem]">
            <div
              ref={plotRef}
              role="group"
              aria-label={ariaLabel}
              onKeyDown={onKeyDown}
              onPointerMove={(e) => {
                if (e.pointerType !== "mouse") return;
                const box = e.currentTarget.getBoundingClientRect();
                setCrosshair(((e.clientX - box.left) / box.width) * 24);
              }}
              onPointerLeave={() => setCrosshair(null)}
              className="relative pt-7"
            >
              <div
                aria-hidden
                className={`${night ? "hours-night" : "hours"} absolute top-7 right-0 bottom-6 left-0`}
              />
              {[6, 12, 18].map((hour) => (
                <div
                  key={hour}
                  aria-hidden
                  className={`absolute top-7 bottom-6 w-px ${quarter}`}
                  style={{ left: pct(hour) }}
                />
              ))}

              {lanes.map((lane) => (
                <div key={lane} className={`relative h-11 border-b ${rule}`}>
                  {events
                    .filter((e) => e.lane === lane)
                    .map((event) => {
                      const index = ordered.indexOf(event);
                      return (
                        <Bar
                          key={`${lane}-${event.at}`}
                          event={event}
                          index={index}
                          night={night}
                          active={shown === index}
                          dimmed={isolated !== null && isolated !== lane}
                          onEnter={() => setActive(index)}
                          onLeave={() => setActive(null)}
                          onPin={() => setPinned((p) => (p === index ? null : index))}
                          tabIndex={index === (shown ?? 0) ? 0 : -1}
                        />
                      );
                    })}
                </div>
              ))}

              {arrival !== undefined && <Arrival at={arrival} label={arrivalLabel} night={night} />}

              {crosshair !== null && crosshair >= 0 && crosshair <= 24 && (
                <div
                  aria-hidden
                  className={`pointer-events-none absolute top-7 bottom-6 w-px ${
                    night ? "bg-paper-50/40" : "bg-zinc-950/30"
                  }`}
                  style={{ left: pct(crosshair) }}
                />
              )}

              <HourScale night={night} crosshair={crosshair} />
            </div>

            {/* Owner column. Each is a button because clicking it isolates the
                lane; it carries the plot's 1.75rem top offset so the labels
                line up with their lanes rather than with the flag row. */}
            <div className="pt-7">
              {lanes.map((lane) => {
                const on = isolated === lane;
                return (
                  <button
                    key={lane}
                    type="button"
                    onClick={() => setIsolated(on ? null : lane)}
                    aria-pressed={on}
                    className={`t-cond flex h-11 w-full items-center border-b pl-4 text-left text-[10px] uppercase tracking-field transition-colors ${rule} ${
                      on
                        ? night
                          ? "text-paper-50"
                          : "text-zinc-950"
                        : `${quiet} ${night ? "hover:text-paper-50" : "hover:text-zinc-950"}`
                    }`}
                  >
                    {lane}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Readout
        night={night}
        summary={summary}
        event={current}
        isolated={isolated}
        onClear={() => {
          setIsolated(null);
          setPinned(null);
        }}
      />
    </div>
  );
}

function Bar({
  event,
  index,
  night,
  active,
  dimmed,
  onEnter,
  onLeave,
  onPin,
  tabIndex,
}: {
  event: GanttEvent;
  index: number;
  night: boolean;
  active: boolean;
  dimmed: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onPin: () => void;
  tabIndex: number;
}) {
  const human = event.state === "decision" || event.state === "approval";
  const label = `${clock(event.at)}${
    event.hours ? ` to ${clock(event.at + event.hours)}` : ""
  }, ${event.lane}, ${event.label}`;

  const shared =
    "absolute top-1/2 -translate-y-1/2 focus-visible:outline-2 focus-visible:outline-offset-2";

  // A moment, not a duration: drawn as its mark on an amber field, because on
  // a light ground amber is a fill carrying near-black and never a stroke.
  if (human) {
    return (
      <button
        type="button"
        data-bar={index}
        tabIndex={tabIndex}
        aria-label={label}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        onClick={onPin}
        style={{ left: pct(event.at) }}
        className={`${shared} flex h-6 items-center gap-1.5 px-1.5 transition-colors ${
          dimmed ? "opacity-40" : ""
        } ${active ? "bg-zinc-950 text-signal-500" : "bg-signal-500 text-zinc-950"}`}
      >
        <Mark state={event.state} className="h-2.5 w-2.5" />
        <span className="t-data whitespace-nowrap text-[10px] leading-none">{clock(event.at)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-bar={index}
      tabIndex={tabIndex}
      aria-label={label}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={onPin}
      style={{ left: pct(event.at), width: pct(event.hours ?? 0.25) }}
      className={`${shared} h-6 min-w-[3px] border transition-colors ${
        night
          ? `border-night-600 ${active ? "bg-paper-50" : dimmed ? "bg-transparent" : "bg-night-800"}`
          : `border-paper-400 border-l-[3px] border-l-zinc-950 ${
              active ? "bg-zinc-950" : dimmed ? "bg-transparent" : "bg-paper-50"
            }`
      }`}
    />
  );
}

function Arrival({ at, label, night }: { at: number; label: string; night: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className="absolute top-0 flex h-7 items-center whitespace-nowrap bg-signal-500 px-2"
        style={{ left: pct(at) }}
      >
        <span className="t-data text-[10px] leading-none text-zinc-950">
          {`${clock(at)} ${label.toUpperCase()}`}
        </span>
      </span>
      <span
        aria-hidden
        className={`absolute top-7 bottom-6 w-0.5 bg-signal-500 ${night ? "" : ""}`}
        style={{ left: pct(at) }}
      />
    </>
  );
}

function HourScale({ night, crosshair }: { night: boolean; crosshair: number | null }) {
  const quiet = night ? "text-zinc-400" : "text-zinc-600";
  return (
    <div aria-hidden className="relative h-6">
      {[0, 6, 12, 18].map((hour) => (
        <span
          key={hour}
          className={`t-data absolute top-1.5 text-[10px] leading-none ${quiet}`}
          style={{ left: pct(hour) }}
        >
          {clock(hour)}
        </span>
      ))}
      <span className={`t-data absolute top-1.5 right-0 text-[10px] leading-none ${quiet}`}>
        24:00
      </span>

      {/* The time under the pointer, printed in the scale rather than floating
          beside the cursor. */}
      {crosshair !== null && crosshair >= 0 && crosshair <= 24 && (
        <span
          className={`t-data absolute top-1.5 -translate-x-1/2 px-1 text-[10px] leading-none ${
            night ? "bg-paper-50 text-zinc-950" : "bg-zinc-950 text-paper-50"
          }`}
          style={{ left: pct(crosshair) }}
        >
          {clock(crosshair)}
        </span>
      )}
    </div>
  );
}

/**
 * The readout.
 *
 * Always present, always the same height, so the chart never reflows when a
 * record appears. It is the accessible description of whatever is focused, and
 * it falls back to the band's own summary when nothing is.
 */
function Readout({
  night,
  summary,
  event,
  isolated,
  onClear,
}: {
  night: boolean;
  summary: string;
  event: GanttEvent | null;
  isolated: string | null;
  onClear: () => void;
}) {
  const quiet = night ? "text-zinc-400" : "text-zinc-600";
  const loud = night ? "text-paper-50" : "text-zinc-950";

  return (
    <div
      aria-live="polite"
      className="mt-3 flex min-h-[1.5rem] flex-wrap items-baseline gap-x-4 gap-y-1"
    >
      {event ? (
        <>
          <span className={`t-data text-[11px] leading-4 ${loud}`}>
            {event.hours ? `${clock(event.at)}–${clock(event.at + event.hours)}` : clock(event.at)}
          </span>
          {event.hours && (
            <span className={`t-data text-[11px] leading-4 ${quiet}`}>{minutes(event.hours)}</span>
          )}
          <span className={`t-cond text-[11px] uppercase tracking-field ${quiet}`}>
            {event.lane}
          </span>
          <span className={`t-body text-[13px] leading-5 ${loud}`}>{event.label}</span>
        </>
      ) : (
        <span className={`t-data text-[11px] leading-4 ${quiet}`}>{summary}</span>
      )}

      {isolated && (
        <button
          type="button"
          onClick={onClear}
          className={`t-cond ml-auto text-[10px] uppercase tracking-field ${quiet} ${
            night ? "hover:text-paper-50" : "hover:text-zinc-950"
          }`}
        >
          {`Showing ${isolated} · clear`}
        </button>
      )}
    </div>
  );
}
