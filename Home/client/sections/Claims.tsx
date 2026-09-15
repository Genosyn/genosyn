import { useEffect, useState } from "react";
import { LANES } from "@/sections/Board";

const CLAIMS = LANES.flatMap((lane) =>
  lane.events
    .filter((event) => event.state === "run" && event.at < 9.5)
    .map((event) => ({ at: event.at, label: event.label, lane: lane.owner })),
).sort((a, b) => a.at - b.at);

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

      <div aria-hidden className="min-h-[5.25rem]">
        <div key={index} className="claim-in">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
              <span
                className={`h-2 w-2 rounded-full ${DEPT[CLAIMS[index].lane] ?? "bg-indigo-600"}`}
              />
              {CLAIMS[index].lane}
            </span>
            <span className="font-mono text-xs text-slate-500">{clock(CLAIMS[index].at)}</span>
          </div>
          <p className="mt-2.5 max-w-[34ch] text-base font-medium leading-6 text-slate-900 sm:text-lg">
            {CLAIMS[index].label}
          </p>
        </div>
      </div>
    </div>
  );
}
