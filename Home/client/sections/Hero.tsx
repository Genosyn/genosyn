import { ArrowRight, BookOpen, CalendarClock, CheckCircle2, Github, Sparkles, Star } from "lucide-react";
import { GITHUB_URL } from "@/lib/constants";

const ROSTER = [
  {
    name: "Mira",
    role: "Bookkeeper",
    initials: "MF",
    color: "bg-emerald-100 text-emerald-700",
    cadence: "Daily · 7:00 AM",
    last: "Reconciled 42 Stripe charges",
    status: "shipped" as const,
  },
  {
    name: "Alex",
    role: "Brand writer",
    initials: "AB",
    color: "bg-sky-100 text-sky-700",
    cadence: "Weekly · Fri 5:00 PM",
    last: "Drafted Friday digest",
    status: "running" as const,
  },
  {
    name: "Sam",
    role: "On-call SRE",
    initials: "SS",
    color: "bg-amber-100 text-amber-700",
    cadence: "Every 15 min",
    last: "Watching p99 on /checkout",
    status: "active" as const,
  },
];

const CHECKS = ["MIT licensed", "Self-hosted", "Bring your own keys", "One Docker command"];

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] bg-[radial-gradient(60%_80%_at_50%_0%,rgba(15,23,42,0.05),transparent_70%)]"
      />

      <div className="mx-auto max-w-7xl px-6 pt-14 pb-20 sm:pt-20 sm:pb-28">
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3.5 py-1.5 text-xs font-medium text-zinc-700 shadow-card transition hover:-translate-y-0.5 hover:border-zinc-300 hover:bg-zinc-50 hover:shadow-lift"
          >
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            Open source on GitHub
            <span className="text-zinc-400">·</span>
            <span className="text-zinc-500">v0.2.0</span>
            <ArrowRight className="h-3.5 w-3.5 text-zinc-400 transition group-hover:translate-x-0.5 group-hover:text-zinc-700" />
          </a>

          <h1 className="mt-7 text-balance font-semibold leading-[1.04] tracking-[-0.035em] text-zinc-950 text-[2.75rem] sm:text-[3.5rem] lg:text-[4.25rem]">
            Run your company with AI employees.
          </h1>

          <p className="mt-6 max-w-xl text-balance text-lg leading-[1.6] text-zinc-600">
            Genosyn is the open-source platform for hiring{" "}
            <span className="font-medium text-zinc-900">AI employees</span>.
            Each one has a written soul, a set of skills, and routines on a
            schedule. They wake up, do their job, and report what they shipped.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href="#quickstart"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 px-6 py-3 text-sm font-semibold text-white shadow-lift transition hover:bg-zinc-800 sm:w-auto"
            >
              Get started for free
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-6 py-3 text-sm font-semibold text-zinc-800 shadow-card transition hover:border-zinc-300 hover:bg-zinc-50 sm:w-auto"
            >
              <Github className="h-4 w-4" />
              Star on GitHub
            </a>
          </div>

          <ul className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-zinc-500">
            {CHECKS.map((c) => (
              <li key={c} className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-zinc-700" />
                {c}
              </li>
            ))}
          </ul>
        </div>

        <RosterPreview />
      </div>
    </section>
  );
}

function RosterPreview() {
  return (
    <div className="relative mx-auto mt-16 max-w-5xl">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-8 -inset-y-12 -z-10 rounded-[3rem] bg-gradient-to-b from-zinc-100/60 via-white to-white blur-2xl"
      />

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lift">
        <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/60 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-zinc-300" />
          </div>
          <div className="ml-2 inline-flex items-center gap-2 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-card">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            genosyn.com / your roster
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 p-6 sm:p-8 md:grid-cols-3">
          {ROSTER.map((r) => (
            <article
              key={r.name}
              className="rounded-xl border border-zinc-200 bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:shadow-lift"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-semibold ${r.color}`}
                  >
                    {r.initials}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-zinc-950">{r.name}</div>
                    <div className="text-xs text-zinc-500">{r.role}</div>
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </div>

              <div className="mt-5 flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                <CalendarClock className="h-3.5 w-3.5 text-zinc-400" />
                {r.cadence}
              </div>

              <div className="mt-3 flex items-start gap-2 text-xs text-zinc-600">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-700" />
                <span>{r.last}</span>
              </div>

              <div className="mt-4 flex items-center justify-between text-[11px] text-zinc-500">
                <span className="inline-flex items-center gap-1.5">
                  <BookOpen className="h-3 w-3" />
                  Soul · Skills · Routines
                </span>
                <ArrowRight className="h-3 w-3" />
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "shipped" | "running" | "active" }) {
  if (status === "shipped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Shipped
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-700 ring-1 ring-zinc-200">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
      Active
    </span>
  );
}
