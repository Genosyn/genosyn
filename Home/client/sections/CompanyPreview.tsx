import type { ReactNode } from "react";
import { Logo, LogoMark } from "@/components/Logo";
import { Mark } from "@/components/Marks";
import type { Dept } from "@/sections/Kit";
import { DEPT_FULL, StateTag } from "@/sections/Kit";

const NAV: { label: string; dept?: Dept; active?: boolean }[] = [
  { label: "Home", active: true },
  { label: "Workspace", dept: "workspace" },
  { label: "AI Employees", dept: "operations" },
  { label: "Routines", dept: "operations" },
  { label: "Tasks", dept: "workspace" },
  { label: "Email", dept: "email" },
  { label: "Marketing", dept: "marketing" },
  { label: "Revenue", dept: "revenue" },
  { label: "Finance", dept: "finance" },
  { label: "Repositories", dept: "repositories" },
];

const ROSTER: { initials: string; name: string; dept: Dept }[] = [
  { initials: "MF", name: "Mira", dept: "finance" },
  { initials: "AB", name: "Alex", dept: "marketing" },
  { initials: "SS", name: "Sam", dept: "repositories" },
];

const STATS = [
  { value: "3", label: "Waiting for you", human: true },
  { value: "18", label: "Runs today", human: false },
  { value: "7", label: "AI Employees", human: false },
  { value: "0", label: "Standdowns", human: false },
];

const RUNS: { at: string; name: string; action: string; meta: string; dept: Dept }[] = [
  {
    at: "04:05",
    name: "Mira",
    action: "reconciled 42 Stripe payments",
    meta: "Finance · Complete",
    dept: "finance",
  },
  {
    at: "07:12",
    name: "Alex",
    action: "drafted the launch digest",
    meta: "Marketing · Complete",
    dept: "marketing",
  },
  {
    at: "08:15",
    name: "Sam",
    action: "opened a fix for the flaky checkout test",
    meta: "Repositories · Running",
    dept: "repositories",
  },
];

const WAITING = [
  {
    state: "decision" as const,
    word: "Decision",
    at: "10:40",
    title: "Write off a £42 discrepancy, or chase it?",
    meta: "Mira · Finance",
  },
  {
    state: "approval" as const,
    word: "Approval",
    at: "13:10",
    title: "Publish the pricing post",
    meta: "Alex · Marketing",
  },
  {
    state: "decision" as const,
    word: "Decision",
    at: "14:05",
    title: "Rebase the fix, or reopen the issue?",
    meta: "Sam · Repositories",
  },
];

export function CompanyPreview() {
  return (
    <div className="select-none">
      <span className="sr-only">
        Northstar Labs in Genosyn at 09:31: eighteen Runs finished since midnight, two Decisions and
        one Approval waiting for an answer, and three AI Employees on duty.
      </span>
      <div aria-hidden className="overflow-hidden bg-white">
        <PreviewHeader />
        <div className="grid min-h-[25rem] md:grid-cols-[12rem_minmax(0,1fr)]">
          <PreviewSidebar />
          <PreviewMain />
        </div>
      </div>
    </div>
  );
}

function PreviewHeader() {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-slate-200 bg-white px-3 sm:gap-3 sm:px-4">
      <LogoMark className="h-6 w-6 shrink-0 text-indigo-600 sm:hidden" />
      <Logo className="hidden shrink-0 text-sm text-slate-950 sm:inline-flex" />
      <span className="h-5 w-px shrink-0 bg-slate-200" />
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">Northstar Labs</span>
      <span className="hidden text-sm text-slate-400 sm:inline">/ Home</span>
      <span className="ml-auto mr-1 hidden rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-medium text-emerald-700 sm:inline">
        All systems operational
      </span>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[10px] font-semibold text-white">
        ND
      </span>
    </div>
  );
}

function PreviewSidebar() {
  return (
    <div className="hidden border-r border-slate-200 bg-white p-3 md:block">
      <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        Company
      </div>

      <div className="space-y-0.5">
        {NAV.map((item) => (
          <div
            key={item.label}
            className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[11px] leading-4 ${
              item.active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                item.active ? "bg-indigo-600" : item.dept ? DEPT_FULL[item.dept] : "bg-slate-300"
              }`}
            />
            {item.label}
          </div>
        ))}
      </div>

      <div className="mt-5 border-t border-slate-100 px-2 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        On duty
      </div>
      {ROSTER.map((member) => (
        <div key={member.name} className="flex items-center gap-2 px-2 py-1.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[9px] font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
            {member.initials}
          </span>
          <span className="min-w-0 truncate text-[11px] text-slate-600">{member.name}</span>
          <span
            className={`ml-auto h-2 w-2 shrink-0 rounded-full ${DEPT_FULL[member.dept]}`}
          />
        </div>
      ))}
    </div>
  );
}

function PreviewMain() {
  return (
    <div className="min-w-0 bg-slate-50 px-3 py-4 sm:px-5 sm:py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-base font-semibold text-slate-950">Good morning, Nawaz</span>
        <span className="font-mono text-[10px] text-slate-400">TUE 09:31</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        Eighteen Runs finished before you signed in. Three need an answer.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className={`rounded-lg border p-3 shadow-sm ${
              stat.human
                ? "border-indigo-200 bg-indigo-50"
                : "border-slate-200 bg-white"
            }`}
          >
            <div
              className={`text-xl font-semibold leading-none tracking-tight ${
                stat.human ? "text-indigo-950" : "text-slate-900"
              }`}
            >
              {stat.value}
            </div>
            <div
              className={`mt-1.5 text-[9px] font-semibold uppercase tracking-wide ${
                stat.human ? "text-indigo-700" : "text-slate-400"
              }`}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.05fr_0.95fr]">
        <PreviewPanel title="Runs since 00:00" count="18">
          {RUNS.map((run) => (
            <div
              key={run.at}
              className="flex items-start gap-2.5 border-t border-slate-100 px-3 py-2.5 first:border-t-0"
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DEPT_FULL[run.dept]}`} />
              <span className="w-[2.75rem] shrink-0 font-mono text-[10px] leading-5 text-slate-400">
                {run.at}
              </span>
              <Mark state="run" className="mt-1.5 h-2.5 w-2.5 shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] leading-5 text-slate-600">
                  <span className="font-medium text-slate-900">{run.name}</span> {run.action}
                </span>
                <span className="mt-0.5 block text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  {run.meta}
                </span>
              </span>
            </div>
          ))}
        </PreviewPanel>

        <PreviewPanel title="Waiting for you" count="3" human>
          {WAITING.map((item) => (
            <div
              key={item.at}
              className="border-t border-indigo-100 px-3 py-2.5 first:border-t-0"
            >
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <StateTag state={item.state}>{item.word}</StateTag>
                <span className="font-mono text-[10px] leading-4 text-slate-400">
                  {item.at}
                </span>
              </span>
              <span className="mt-1.5 block text-[11px] leading-5 text-slate-700">
                {item.title}
              </span>
              <span className="mt-0.5 block text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                {item.meta}
              </span>
            </div>
          ))}
        </PreviewPanel>
      </div>
    </div>
  );
}

function PreviewPanel({
  title,
  count,
  human = false,
  children,
}: {
  title: string;
  count: string;
  human?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border shadow-sm ${
        human ? "border-indigo-200 bg-indigo-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <div
        className={`flex items-center justify-between gap-3 border-b px-3 py-2.5 ${
          human ? "border-indigo-100 bg-indigo-50" : "border-slate-100 bg-white"
        }`}
      >
        <span
          className={`text-[10px] font-semibold ${human ? "text-indigo-700" : "text-slate-700"}`}
        >
          {title}
        </span>
        <span className="font-mono text-[10px] leading-4 text-slate-400">{count}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}
