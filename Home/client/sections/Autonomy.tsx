import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@/lib/router";
import { SectionEyebrow } from "@/sections/Primitives";

type Level = {
  icon: LucideIcon;
  title: string;
  tag: string;
  body: string;
};

/**
 * The four levels are the product told as a ladder: chat, Skills, Routines,
 * and handoffs between employees. Each rung removes one more human trigger,
 * which is the whole claim of the page — a company that keeps running when
 * nobody is asking it to.
 */
const LEVELS: Level[] = [
  {
    icon: MessageSquare,
    title: "You ask, it does",
    tag: "Human starts it",
    body: "A Member asks in Workspace chat. The AI Employee does the work now, inside your systems, and leaves a Run you can read line by line.",
  },
  {
    icon: Sparkles,
    title: "You write it down once",
    tag: "Human defines it",
    body: "Turn the ask into a Skill — trigger, steps, definition of done. Every employee who needs that job runs it the same way, without being told again.",
  },
  {
    icon: CalendarClock,
    title: "It runs without being asked",
    tag: "No human needed",
    body: "Routines fire on cron. Reconciliation at 07:00, the brief at 08:30, the digest on Friday — through the night, through the weekend, through your holiday.",
  },
  {
    icon: Bot,
    title: "The company keeps moving",
    tag: "Human by exception",
    body: "Employees pick up each other's handoffs across Tasks, Email, Revenue, and Repositories. What reaches you is the short list that genuinely needs a person.",
  },
];

const AUTONOMOUS = [
  { time: "02:14", body: "Sam opened a fix for the overnight error spike", where: "Repositories" },
  { time: "07:00", body: "Mira reconciled 42 payments and filed the exceptions", where: "Finance" },
  {
    time: "08:30",
    body: "The morning TLDR landed, answering the standing questions",
    where: "Workspace",
  },
  { time: "09:12", body: "Alex cleared 12 support threads and tagged 3 to watch", where: "Email" },
  { time: "All day", body: "Six deals moved a stage on evidence from the thread", where: "Revenue" },
];

const ESCALATED = [
  { body: "Approve the $4,000 campaign budget", where: "Alex · Paid Marketing" },
  { body: "Sign off on the checkout patch before it merges", where: "Sam · Repositories" },
  { body: "Which entity books this refund?", where: "Mira · Finance" },
];

export function Autonomy() {
  return (
    <section id="autonomy" className="border-y border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-7xl px-5 py-20 sm:px-6 sm:py-24 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-[1.02fr_0.98fr] lg:gap-16">
          <div>
            <SectionEyebrow>Autonomy, level by level</SectionEyebrow>
            <h2 className="mt-5 max-w-xl text-balance text-4xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-5xl">
              Work that stops needing you to start it.
            </h2>
            <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-slate-600 sm:text-lg">
              Autonomy is not a switch you flip on day one. It is a ladder you climb one job at a
              time — and in Genosyn every rung is a plain document you can read, edit, or take back.
            </p>

            <ol className="mt-10">
              {LEVELS.map((level, index) => (
                <li key={level.title} className="relative flex gap-4 pb-7 last:pb-0">
                  {index < LEVELS.length - 1 && (
                    <span
                      aria-hidden
                      className="absolute bottom-1 left-[1.125rem] top-11 w-px bg-slate-300"
                    />
                  )}
                  <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-950 shadow-sm">
                    <level.icon aria-hidden className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 className="text-base font-semibold text-slate-900">{level.title}</h3>
                      <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                        {level.tag}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{level.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <Link
              href="/docs/routines"
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-950 transition hover:text-slate-700"
            >
              Read how Routines and Runs work
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </div>

          <div className="lg:pt-2">
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_24px_60px_-38px_rgba(15,23,42,0.5)]">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    One Tuesday · Northstar Labs
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    Nobody signed in until 09:30
                  </div>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Ran itself
                </span>
              </div>

              <div className="px-5 py-4">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Happened without a human
                </div>
                <ul className="mt-3 space-y-3">
                  {AUTONOMOUS.map((item) => (
                    <li key={item.body} className="flex gap-3">
                      <span className="w-12 shrink-0 pt-0.5 font-mono text-[10px] font-semibold text-slate-400">
                        {item.time}
                      </span>
                      <CheckCircle2
                        aria-hidden
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                      />
                      <span className="min-w-0 text-xs leading-5 text-slate-700">
                        {item.body}
                        <span className="ml-1.5 text-[10px] text-slate-400">{item.where}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Waited for you
                  </div>
                  <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                    3 items
                  </span>
                </div>
                <ul className="mt-3 space-y-2">
                  {ESCALATED.map((item) => (
                    <li
                      key={item.body}
                      className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2.5"
                    >
                      <ShieldCheck aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-950" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-slate-800">
                          {item.body}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-slate-400">
                          {item.where}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <p className="mt-4 px-1 text-xs leading-5 text-slate-500">
              An autonomous company is not one that never asks. It is one where the asking is rare,
              specific, and worth your time.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
