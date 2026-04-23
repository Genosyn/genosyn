import { CheckCircle2, Clock, Loader2 } from "lucide-react";

type TimelineEntry = {
  time: string;
  employee: string;
  initials: string;
  accent: string;
  routine: string;
  output: string;
  status: "done" | "running" | "scheduled";
};

const TIMELINE: TimelineEntry[] = [
  {
    time: "07:00",
    employee: "Mira Finance",
    initials: "MF",
    accent: "bg-emerald-100 text-emerald-700",
    routine: "Daily bookkeeping",
    output: "Reconciled 42 Stripe charges · 0 anomalies",
    status: "done",
  },
  {
    time: "08:30",
    employee: "Alex Brand",
    initials: "AB",
    accent: "bg-indigo-100 text-indigo-700",
    routine: "Morning brief",
    output: "Drafted 3 talking points from overnight news",
    status: "done",
  },
  {
    time: "10:17",
    employee: "Sam SRE",
    initials: "SS",
    accent: "bg-amber-100 text-amber-700",
    routine: "Alert triage",
    output: "Paged #oncall · elevated p99 on /checkout",
    status: "running",
  },
  {
    time: "14:00",
    employee: "Alex Brand",
    initials: "AB",
    accent: "bg-indigo-100 text-indigo-700",
    routine: "Docs freshness pass",
    output: "Queued · waiting on slot",
    status: "scheduled",
  },
  {
    time: "17:00",
    employee: "Alex Brand",
    initials: "AB",
    accent: "bg-indigo-100 text-indigo-700",
    routine: "Friday weekly report",
    output: "Scheduled · fires on Friday",
    status: "scheduled",
  },
];

export function DayInTheLife() {
  return (
    <section
      id="day-in-the-life"
      className="relative border-t border-slate-200 bg-slate-50/60"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,theme(colors.slate.200/35)_1px,transparent_1px)] bg-[size:48px_100%] [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]"
      />
      <div className="relative mx-auto max-w-6xl px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 shadow-sm">
            <Clock className="h-3.5 w-3.5 text-indigo-500" />
            A typical Tuesday
          </div>
          <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
            Scheduled, not chatty.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">
            Your roster works on crons. You see what ran, what shipped, what is
            queued. No Slack noise. No &ldquo;just checking in.&rdquo;
          </p>
        </div>

        <div className="mx-auto mt-14 max-w-3xl">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 text-xs text-slate-500">
              <div className="flex items-center gap-2 font-medium">
                <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
                Live · 3 employees on duty
              </div>
              <div className="font-mono text-[11px]">tue · apr 23</div>
            </div>
            <ol className="divide-y divide-slate-100">
              {TIMELINE.map((entry) => (
                <TimelineRow key={`${entry.time}-${entry.routine}`} entry={entry} />
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  return (
    <li className="flex items-start gap-3 px-4 py-4 sm:grid sm:grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:px-6">
      <div className="w-14 shrink-0 pt-1 font-mono text-sm tabular-nums text-slate-500 sm:w-auto sm:pt-0">
        {entry.time}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${entry.accent}`}
        >
          {entry.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <div className="truncate text-sm font-semibold text-slate-900">
              {entry.employee}
            </div>
            <div className="truncate text-xs text-slate-500">{entry.routine}</div>
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-slate-500 sm:truncate">
            {entry.output}
          </div>
          <div className="mt-2 sm:hidden">
            <StatusPill status={entry.status} />
          </div>
        </div>
      </div>

      <div className="hidden sm:block">
        <StatusPill status={entry.status} />
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: TimelineEntry["status"] }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Shipped
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600 ring-1 ring-slate-200">
      <Clock className="h-3 w-3" />
      Queued
    </span>
  );
}
