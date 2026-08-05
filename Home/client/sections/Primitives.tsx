import type { ReactNode } from "react";
import {
  BookHeart,
  CalendarClock,
  Check,
  KeyRound,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

type Primitive = {
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
  lines: string[];
};

const PRIMITIVES: Primitive[] = [
  {
    icon: BookHeart,
    label: "Soul",
    title: "Who they are",
    body: "A readable constitution for judgment, voice, priorities, and boundaries.",
    lines: ["Be exact with financial data", "Surface uncertainty", "Never invent a number"],
  },
  {
    icon: Sparkles,
    label: "Skills",
    title: "How they work",
    body: "Reusable markdown playbooks for the jobs your company repeats.",
    lines: ["reconcile-payments", "prepare-weekly-brief", "triage-inbox"],
  },
  {
    icon: CalendarClock,
    label: "Routines",
    title: "When they work",
    body: "Cron-scheduled work with a clear brief, chosen AI Model, and readable Run history.",
    lines: ["Morning brief · 08:30", "Reconcile · 07:00", "Digest · Fri 17:00"],
  },
  {
    icon: KeyRound,
    label: "Grants",
    title: "What they can reach",
    body: "Explicit access to Connections, Notes, Bases, repositories, and other company resources.",
    lines: ["Finance connection", "Operations notebook", "Checkout repository"],
  },
];

export function Primitives() {
  return (
    <section className="border-y border-slate-800 bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-400/25 bg-slate-400/10 px-3 py-1 text-[11px] font-semibold text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
              The employee model
            </span>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
              More than a prompt. A complete operating role.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-400 sm:text-lg">
              Every AI Employee is assembled from plain, editable building blocks stored with your
              company data. Change the role without rebuilding the system around it.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {["Readable", "Portable", "Database-backed", "Auditable"].map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-slate-300"
                >
                  <Check className="h-3 w-3 text-slate-400" />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {PRIMITIVES.map((primitive) => (
              <article
                key={primitive.label}
                className="rounded-xl border border-white/10 bg-white/[0.045] p-5 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-slate-300 ring-1 ring-inset ring-slate-400/20">
                    <primitive.icon className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                      {primitive.label}
                    </div>
                    <h3 className="mt-0.5 text-sm font-semibold text-white">{primitive.title}</h3>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-slate-400">{primitive.body}</p>
                <ul className="mt-4 space-y-1.5 border-t border-white/10 pt-4">
                  {primitive.lines.map((line) => (
                    <li key={line} className="flex items-center gap-2 text-[11px] text-slate-300">
                      <span className="h-1 w-1 rounded-full bg-slate-400" />
                      {line}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-800">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-900" />
      {children}
    </div>
  );
}
