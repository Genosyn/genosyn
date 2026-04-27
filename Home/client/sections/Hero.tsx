import {
  ArrowUpRight,
  BookOpen,
  CalendarClock,
  CircleCheck,
  Github,
  Sparkles,
  Star,
} from "lucide-react";
import { GITHUB_URL, ROADMAP_URL } from "@/lib/constants";

type RosterItem = {
  name: string;
  role: string;
  initials: string;
  accent: string;
  cadence: string;
  lastShipped: string;
};

const ROSTER: RosterItem[] = [
  {
    name: "Alex Brand",
    role: "Senior brand writer",
    initials: "AB",
    accent: "bg-indigo-100 text-indigo-700",
    cadence: "Weekly · Fri 09:00",
    lastShipped: "Shipped Friday digest",
  },
  {
    name: "Mira Finance",
    role: "Bookkeeper",
    initials: "MF",
    accent: "bg-emerald-100 text-emerald-700",
    cadence: "Daily · 07:00",
    lastShipped: "Closed the books",
  },
  {
    name: "Sam SRE",
    role: "On-call engineer",
    initials: "SS",
    accent: "bg-amber-100 text-amber-700",
    cadence: "Hourly",
    lastShipped: "Triaged 3 alerts",
  },
];

const TRUST_POINTS = [
  "MIT licensed",
  "Runs on SQLite",
  "One-command Docker install",
  "Your keys, your models",
];

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(circle_at_top,theme(colors.indigo.100/70%),transparent_55%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,theme(colors.slate.200/40)_1px,transparent_1px),linear-gradient(to_bottom,theme(colors.slate.200/40)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]"
      />

      <div className="relative mx-auto max-w-6xl px-6 pt-16 pb-24 sm:pt-24 sm:pb-28">
        <div className="grid items-start gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-16">
          <div className="text-center lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-indigo-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
              </span>
              v0.2.0 · Building in the open
            </div>
            <h1 className="mt-6 text-[2.5rem] font-semibold leading-[1.05] tracking-tight text-slate-900 sm:text-6xl lg:text-[4.25rem] lg:leading-[1.04]">
              Run companies
              <br className="hidden sm:block" />{" "}
              <span className="bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-500 bg-clip-text text-transparent">
                autonomously.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-slate-600 lg:mx-0">
              Genosyn is a roster of AI employees. Each has a written{" "}
              <b className="font-semibold text-slate-900">Soul</b>, a set of{" "}
              <b className="font-semibold text-slate-900">Skills</b>, and{" "}
              <b className="font-semibold text-slate-900">Routines</b> on a cron.
              Hire them, read what they shipped, own every line.
            </p>
            <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row lg:justify-start">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 sm:w-auto"
              >
                <Github className="h-4 w-4" />
                View on GitHub
                <Star className="ml-1 h-3.5 w-3.5 text-amber-300" />
              </a>
              <a
                href="#quickstart"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-300 hover:text-slate-900 sm:w-auto"
              >
                Quickstart
                <ArrowUpRight className="h-4 w-4" />
              </a>
              <a
                href={ROADMAP_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 px-2 py-3 text-sm font-medium text-slate-600 hover:text-slate-900 sm:w-auto"
              >
                Read the roadmap
              </a>
            </div>
            <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500 lg:justify-start">
              {TRUST_POINTS.map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5">
                  <CircleCheck className="h-3.5 w-3.5 text-indigo-500" />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <RosterPreview />
        </div>
      </div>
    </section>
  );
}

function RosterPreview() {
  return (
    <div className="relative mx-auto w-full max-w-xl lg:max-w-none">
      <div
        aria-hidden
        className="absolute -inset-x-6 -inset-y-10 -rotate-1 rounded-[2rem] bg-gradient-to-br from-indigo-200/50 via-white to-violet-200/40 blur-2xl"
      />

      <div className="relative space-y-3">
        <div className="flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <span>Your roster</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-emerald-700 shadow-sm ring-1 ring-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            3 on duty
          </span>
        </div>

        {ROSTER.map((r, i) => (
          <EmployeeCard key={r.name} employee={r} index={i} />
        ))}
      </div>
    </div>
  );
}

function EmployeeCard({ employee, index }: { employee: RosterItem; index: number }) {
  return (
    <div
      className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm ring-1 ring-transparent backdrop-blur transition hover:-translate-y-0.5 hover:shadow-md hover:ring-indigo-100 sm:p-5"
      style={{ transform: `rotate(${index === 1 ? "0" : index === 0 ? "-0.3deg" : "0.3deg"})` }}
    >
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold tracking-tight ${employee.accent}`}
      >
        {employee.initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="truncate text-sm font-semibold text-slate-900">{employee.name}</div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
            <CalendarClock className="h-3 w-3" />
            {employee.cadence}
          </span>
        </div>
        <div className="truncate text-xs text-slate-500">{employee.role}</div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
          <BookOpen className="h-3 w-3 text-indigo-500" />
          <span>Soul</span>
          <span className="text-slate-300">·</span>
          <Sparkles className="h-3 w-3 text-indigo-500" />
          <span>Skills</span>
          <span className="text-slate-300">·</span>
          <span className="truncate font-medium text-slate-700">{employee.lastShipped}</span>
        </div>
      </div>
    </div>
  );
}
