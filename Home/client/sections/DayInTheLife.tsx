import { CheckCircle2, Clock, Loader2 } from "lucide-react";
import { SectionEyebrow } from "@/sections/Primitives";

type Entry = {
  time: string;
  who: string;
  initials: string;
  color: string;
  routine: string;
  output: string;
  status: "shipped" | "running" | "scheduled";
};

const ENTRIES: Entry[] = [
  {
    time: "07:00",
    who: "Mira",
    initials: "MF",
    color: "bg-emerald-100 text-emerald-700",
    routine: "Daily bookkeeping",
    output: "Reconciled 42 Stripe charges · 0 anomalies",
    status: "shipped",
  },
  {
    time: "08:30",
    who: "Alex",
    initials: "AB",
    color: "bg-violet-100 text-violet-700",
    routine: "Morning brief",
    output: "Drafted 3 talking points from overnight news",
    status: "shipped",
  },
  {
    time: "10:17",
    who: "Sam",
    initials: "SS",
    color: "bg-amber-100 text-amber-700",
    routine: "Watch p99",
    output: "Paged #oncall — elevated p99 on /checkout",
    status: "running",
  },
  {
    time: "14:00",
    who: "Alex",
    initials: "AB",
    color: "bg-violet-100 text-violet-700",
    routine: "Docs freshness pass",
    output: "Queued · waiting on slot",
    status: "scheduled",
  },
  {
    time: "17:00",
    who: "Alex",
    initials: "AB",
    color: "bg-violet-100 text-violet-700",
    routine: "Weekly digest",
    output: "Scheduled · fires Friday 5:00 PM",
    status: "scheduled",
  },
];

export function DayInTheLife() {
  return (
    <section
      id="day"
      className="relative border-t border-zinc-100 bg-gradient-to-b from-zinc-50/60 to-white"
    >
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-28">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-16">
          <div>
            <SectionEyebrow>A typical Tuesday</SectionEyebrow>
            <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] text-zinc-950 sm:text-5xl">
              Scheduled, not chatty.
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-zinc-600">
              Your roster works on crons. You see what ran, what shipped, what
              is queued. Open the timeline when you want to know what
              happened. Close it when you don&apos;t.
            </p>
            <ul className="mt-8 space-y-3">
              {[
                "Cron-driven routines, not chat threads",
                "Every run logged and auditable",
                "Quiet until something needs you",
              ].map((b) => (
                <li key={b} className="flex items-start gap-2 text-sm text-zinc-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />
                  {b}
                </li>
              ))}
            </ul>
          </div>

          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50/60 px-5 py-3 text-xs">
              <div className="flex items-center gap-2 font-medium text-zinc-700">
                <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
                Live · 3 employees on duty
              </div>
              <div className="font-mono text-[11px] text-zinc-500">tue · apr 28</div>
            </div>
            <ol className="divide-y divide-zinc-100">
              {ENTRIES.map((e) => (
                <Row key={`${e.time}-${e.routine}`} entry={e} />
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ entry }: { entry: Entry }) {
  return (
    <li className="grid grid-cols-[60px_minmax(0,1fr)_auto] items-center gap-4 px-5 py-4">
      <div className="font-mono text-sm tabular text-zinc-500">{entry.time}</div>
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${entry.color}`}
        >
          {entry.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-semibold text-zinc-950">
              {entry.who}
            </span>
            <span className="truncate text-xs text-zinc-500">{entry.routine}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-zinc-500">{entry.output}</div>
        </div>
      </div>
      <StatusPill status={entry.status} />
    </li>
  );
}

function StatusPill({ status }: { status: Entry["status"] }) {
  if (status === "shipped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Shipped
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 ring-1 ring-zinc-200">
      <Clock className="h-3 w-3" />
      Queued
    </span>
  );
}
