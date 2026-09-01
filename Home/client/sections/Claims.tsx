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
).sort((a, b) => a.at - b.at);

/** Each department's hue, bound permanently. Colour is the org chart. */
const DEPT: Record<string, string> = {
  Finance: "bg-dept-finance",
  Repositories: "bg-dept-repositories",
  Marketing: "bg-dept-marketing",
  Workspace: "bg-dept-workspace",
  Email: "bg-dept-email",
  Revenue: "bg-dept-revenue",
  Operations: "bg-dept-operations",
};

function clock(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

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
        {`Overnight, without anyone signed in: ${CLAIMS.map((c) => `${c.lane}, ${clock(c.at)}, ${c.label}`).join(";")}.`}
      </span>

      {/* A fixed min-height, so a swap never reflows the page under a reader's
          cursor. The department chip's hue changes INSTANTLY with no colour
          transition: tweening a hue would briefly display a department that
          does not exist. */}
      <div aria-hidden className="min-h-[5.25rem]">
        <div key={index} className="claim-in">
          <div className="flex items-center gap-2.5">
            <span
              className={`t-field rounded-chip px-2 py-1 leading-none text-surface ${
                DEPT[CLAIMS[index].lane] ?? "bg-ink"
              }`}
            >
              {CLAIMS[index].lane}
            </span>
            <span className="t-data text-[12px] text-muted">{clock(CLAIMS[index].at)}</span>
          </div>
          <p className="mt-2.5 max-w-[34ch] text-[clamp(1.125rem,1.7vw,1.5rem)] font-medium leading-[1.35] text-ink">
            {CLAIMS[index].label}
          </p>
        </div>
      </div>
    </div>
  );
}
