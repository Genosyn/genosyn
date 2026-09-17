import { useId, useState } from "react";
import { ArrowRight } from "lucide-react";
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

export function Claims({ className = "" }: { className?: string }) {
  const exampleId = useId();
  const [index, setIndex] = useState(0);
  const claim = CLAIMS[index];

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-slate-500">A sample night at work</p>
        <button
          type="button"
          aria-controls={exampleId}
          onClick={() => setIndex((value) => (value + 1) % CLAIMS.length)}
          className="group -mr-2 inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-indigo-600 transition-colors hover:bg-indigo-50 hover:text-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          Next example
          <ArrowRight
            aria-hidden
            className="h-3.5 w-3.5 transition-transform motion-safe:group-hover:translate-x-0.5"
          />
        </button>
      </div>

      <div
        id={exampleId}
        aria-live="polite"
        aria-atomic="true"
        className="min-h-[7rem] sm:min-h-[5.5rem]"
      >
        <div key={index} className="claim-in">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
              <span
                aria-hidden
                className={`h-2 w-2 rounded-full ${DEPT[claim.lane] ?? "bg-indigo-600"}`}
              />
              {claim.lane}
            </span>
            <span className="font-mono text-xs text-slate-500">{clock(claim.at)}</span>
          </div>
          <p className="mt-2.5 max-w-[34ch] text-base font-medium leading-6 text-slate-900 sm:text-lg">
            {claim.label}
          </p>
        </div>
      </div>
    </div>
  );
}
