import { useEffect, useState } from "react";
import { LANES } from "@/sections/Board";

/**
 * The rotating proof line under the hero claim.
 *
 * The headline makes the promise; this cycles the evidence for it. Every line
 * is a real overnight Run from the board's own event list, so the claim above
 * and the proof below cannot drift apart and nothing here is written for the
 * page — if a Run changes, this changes.
 *
 * ## Server and screen readers
 *
 * The server renders the first claim and nothing else, and the client's first
 * render matches it, so the markup is identical across all 83 prerendered
 * routes and hydration is clean. The cycling starts in an effect.
 *
 * The visible line is `aria-hidden` because a region that rewrites itself
 * every few seconds is hostile to a screen reader; the full list is emitted
 * once in an `sr-only` node instead, so a non-visual reader gets all of the
 * evidence at once rather than a sixth of it at random.
 */
const CLAIMS = LANES.flatMap((lane) =>
  lane.events
    .filter((event) => event.state === "run" && event.at < 9.5)
    .map((event) => ({ at: event.at, label: event.label, lane: lane.owner })),
)
  .sort((a, b) => a.at - b.at)
  .map((event) => event.label);

const INTERVAL = 2600;

export function Claims({ className = "" }: { className?: string }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % CLAIMS.length), INTERVAL);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={className}>
      <span className="sr-only">
        {`Overnight, without anyone signed in: ${CLAIMS.join("; ")}.`}
      </span>

      {/* A fixed height, so the line swapping never reflows the page under a
          reader's cursor. */}
      <span
        aria-hidden
        className="relative flex min-h-[2.5em] items-baseline gap-3 overflow-hidden"
      >
        <span
          key={index}
          className="claim-in t-display text-[clamp(1.25rem,2.4vw,2rem)] leading-[1.25] tracking-[-0.015em] text-zinc-950"
        >
          {CLAIMS[index]}
        </span>
      </span>
    </div>
  );
}
