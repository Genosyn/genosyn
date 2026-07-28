import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleDollarSign,
  Code2,
  FileCheck2,
  Headphones,
  MailCheck,
  MessageSquareText,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

type OutcomeStep = {
  label: string;
  detail: string;
  meta: string;
  icon: LucideIcon;
};

export type CompanyOutcome = {
  id: string;
  shortLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  role: string;
  employee: string;
  initials: string;
  accent: string;
  accentSoft: string;
  goal: string;
  outcome: string;
  proof: string;
  steps: OutcomeStep[];
};

export const COMPANY_OUTCOMES: CompanyOutcome[] = [
  {
    id: "revenue",
    shortLabel: "Grow revenue",
    eyebrow: "Revenue",
    title: "Turn buying intent into a conversation.",
    description:
      "Watch product usage, assemble the account story, and prepare a personal follow-up while the signal is still warm.",
    role: "Revenue operator",
    employee: "Nia",
    initials: "NR",
    accent: "text-emerald-300",
    accentSoft: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20",
    goal: "Create qualified conversations from high-intent product signals",
    outcome: "Personal follow-up ready",
    proof: "Acme crossed the expansion threshold 4 minutes ago",
    steps: [
      {
        label: "Signal found",
        detail: "Acme reached 12 active seats and invited three teammates.",
        meta: "Usage · just now",
        icon: TrendingUp,
      },
      {
        label: "Context assembled",
        detail: "Contact role, account history, usage, and last touch are in one brief.",
        meta: "4 sources · 18 sec",
        icon: Search,
      },
      {
        label: "Follow-up prepared",
        detail: "A personal note and next-best action are waiting for review.",
        meta: "Approval requested",
        icon: MailCheck,
      },
    ],
  },
  {
    id: "engineering",
    shortLabel: "Ship software",
    eyebrow: "Engineering",
    title: "Move from failed check to reviewed fix.",
    description:
      "Give an AI Employee the repository, runbook, and definition of done. It investigates, tests, and brings back a patch.",
    role: "Software engineer",
    employee: "Sam",
    initials: "SE",
    accent: "text-sky-300",
    accentSoft: "bg-sky-400/10 text-sky-300 ring-sky-400/20",
    goal: "Keep checkout healthy without adding another on-call handoff",
    outcome: "Patch ready for review",
    proof: "Checkout p99 breached the team threshold",
    steps: [
      {
        label: "Incident understood",
        detail: "The failing path and the last deployment were compared.",
        meta: "Logs + deploy · 22 sec",
        icon: Search,
      },
      {
        label: "Change prepared",
        detail: "A guarded retry fixes the timeout without changing the API.",
        meta: "3 files changed",
        icon: Code2,
      },
      {
        label: "Checks passed",
        detail: "Tests are green and the focused diff is ready for a human merge.",
        meta: "Review requested",
        icon: FileCheck2,
      },
    ],
  },
  {
    id: "support",
    shortLabel: "Keep customers",
    eyebrow: "Customer experience",
    title: "Resolve the thread with the full customer story.",
    description:
      "Triage the inbox, pull the right history, and draft a grounded response without making customers repeat themselves.",
    role: "Support specialist",
    employee: "Maya",
    initials: "MS",
    accent: "text-violet-300",
    accentSoft: "bg-violet-400/10 text-violet-300 ring-violet-400/20",
    goal: "Respond to important customer threads with complete context",
    outcome: "Grounded reply drafted",
    proof: "Northstar reported a billing mismatch",
    steps: [
      {
        label: "Thread triaged",
        detail: "Billing urgency and customer sentiment were classified.",
        meta: "Priority · high",
        icon: Headphones,
      },
      {
        label: "History connected",
        detail: "The invoice, earlier conversation, and account owner were found.",
        meta: "3 records · 12 sec",
        icon: Search,
      },
      {
        label: "Reply drafted",
        detail: "A clear explanation and next step are ready for the owner.",
        meta: "Human send required",
        icon: MessageSquareText,
      },
    ],
  },
  {
    id: "finance",
    shortLabel: "Close the books",
    eyebrow: "Finance",
    title: "Reconcile the day. Surface only the exception.",
    description:
      "Match routine transactions automatically, preserve the audit trail, and bring ambiguous work to a Member.",
    role: "Bookkeeper",
    employee: "Mira",
    initials: "MF",
    accent: "text-amber-300",
    accentSoft: "bg-amber-400/10 text-amber-300 ring-amber-400/20",
    goal: "Keep the ledger current without turning finance into a queue",
    outcome: "41 of 42 charges matched",
    proof: "Stripe reconciliation started on schedule at 07:00",
    steps: [
      {
        label: "Payments imported",
        detail: "Forty-two charges arrived with invoice and customer context.",
        meta: "Stripe · 07:00",
        icon: CircleDollarSign,
      },
      {
        label: "Ledger reconciled",
        detail: "Forty-one charges matched and the books remain balanced.",
        meta: "41 matched · 31 sec",
        icon: Check,
      },
      {
        label: "Exception routed",
        detail: "One unfamiliar charge is waiting for a Member to classify.",
        meta: "Approval requested",
        icon: ShieldCheck,
      },
    ],
  },
];

export function useOutcomeMotion(autoRotate = true) {
  const [outcomeIndex, setOutcomeIndex] = useState(0);
  const [phase, setPhase] = useState(0);
  const [motionEnabled, setMotionEnabled] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setMotionEnabled(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (!motionEnabled) {
      setPhase(COMPANY_OUTCOMES[0].steps.length - 1);
      return;
    }

    const timer = window.setTimeout(() => {
      if (phase < COMPANY_OUTCOMES[outcomeIndex].steps.length - 1) {
        setPhase((current) => current + 1);
        return;
      }

      setPhase(0);
      if (autoRotate) {
        setOutcomeIndex((current) => (current + 1) % COMPANY_OUTCOMES.length);
      }
    }, phase === COMPANY_OUTCOMES[outcomeIndex].steps.length - 1 ? 2600 : 1800);

    return () => window.clearTimeout(timer);
  }, [autoRotate, motionEnabled, outcomeIndex, phase]);

  const selectOutcome = (index: number) => {
    setOutcomeIndex(index);
    setPhase(0);
  };

  return {
    outcomeIndex,
    outcome: COMPANY_OUTCOMES[outcomeIndex],
    phase,
    selectOutcome,
  };
}

export function OutcomeTabs({
  activeIndex,
  onSelect,
  className = "",
}: {
  activeIndex: number;
  onSelect: (index: number) => void;
  className?: string;
}) {
  return (
    <div
      className={`flex gap-1.5 overflow-x-auto rounded-2xl border border-zinc-200 bg-white/80 p-1.5 shadow-sm scrollbar-none ${className}`}
      role="tablist"
      aria-label="Choose a company outcome"
    >
      {COMPANY_OUTCOMES.map((outcome, index) => (
        <button
          key={outcome.id}
          type="button"
          role="tab"
          aria-selected={activeIndex === index}
          onClick={() => onSelect(index)}
          className={`min-w-max rounded-xl px-3.5 py-2 text-xs font-semibold transition sm:px-4 ${
            activeIndex === index
              ? "bg-zinc-950 text-white shadow-sm"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950"
          }`}
        >
          {outcome.shortLabel}
        </button>
      ))}
    </div>
  );
}

export function CompanyDemo({
  outcome,
  phase,
  compact = false,
}: {
  outcome: CompanyOutcome;
  phase: number;
  compact?: boolean;
}) {
  return (
    <div
      className={`company-demo select-none overflow-hidden rounded-[1.6rem] border border-white/10 bg-[#101110] text-white shadow-[0_36px_100px_-34px_rgba(10,12,10,0.7)] ${
        compact ? "company-demo-compact" : ""
      }`}
      aria-label={`Animated Genosyn use case: ${outcome.title}`}
    >
      <span className="sr-only">
        {outcome.employee}, an AI Employee working as a {outcome.role}, is completing the goal:
        {" "}
        {outcome.goal}.
      </span>

      <div aria-hidden className="flex h-12 items-center gap-2.5 border-b border-white/10 px-4">
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/25">
          <span className="h-2 w-2 rounded-full bg-emerald-300" />
        </span>
        <span className="text-[10px] font-bold tracking-[0.2em]">GENOSYN</span>
        <span className="h-4 w-px bg-white/10" />
        <span className="text-[10px] font-medium text-zinc-500">Northstar Labs</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.16em] text-emerald-300">
          <span className="company-demo-live h-1.5 w-1.5 rounded-full bg-emerald-300" />
          Company live
        </span>
      </div>

      <div aria-hidden className="grid min-h-[31rem] md:grid-cols-[9.5rem_minmax(0,1fr)] xl:grid-cols-[9.5rem_minmax(0,1fr)_12.5rem]">
        <aside className="hidden border-r border-white/10 bg-black/20 p-3 md:block">
          <div className="px-1.5 text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-600">
            AI Employees
          </div>
          <div className="mt-3 space-y-1.5">
            {COMPANY_OUTCOMES.map((candidate) => (
              <div
                key={candidate.id}
                className={`flex items-center gap-2 rounded-lg px-2 py-2 transition ${
                  candidate.id === outcome.id ? "bg-white/10" : "opacity-45"
                }`}
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-lg text-[8px] font-bold ring-1 ${candidate.accentSoft}`}
                >
                  {candidate.initials}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[9px] font-semibold text-zinc-200">
                    {candidate.employee}
                  </span>
                  <span className="block truncate text-[8px] text-zinc-600">
                    {candidate.eyebrow}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="mt-5 border-t border-white/10 px-1.5 pt-4">
            <div className="text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-600">
              Today
            </div>
            <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-white">18</div>
            <div className="mt-0.5 text-[8px] leading-4 text-zinc-600">Runs completed</div>
          </div>
        </aside>

        <div className="min-w-0 bg-[#f3f3ef] p-3 text-zinc-950 sm:p-4">
          <div className="flex items-start gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[10px] font-bold ring-1 ${outcome.accentSoft}`}
            >
              {outcome.initials}
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-zinc-950">
                {outcome.employee} · {outcome.role}
              </div>
              <div className="mt-0.5 text-[9px] text-zinc-500">{outcome.proof}</div>
            </div>
            <span className="ml-auto hidden items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[8px] font-bold uppercase tracking-[0.12em] text-emerald-700 sm:inline-flex">
              <Sparkles className="h-2.5 w-2.5" />
              Working
            </span>
          </div>

          <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
            <div className="text-[8px] font-bold uppercase tracking-[0.16em] text-zinc-400">
              Today&apos;s outcome
            </div>
            <p className="mt-1.5 text-[11px] font-semibold leading-4 text-zinc-900">
              {outcome.goal}
            </p>
          </div>

          <div key={outcome.id} className="mt-3 space-y-2">
            {outcome.steps.map((step, index) => {
              const StepIcon = step.icon;
              const isVisible = index <= phase;
              const isActive = index === phase;
              return (
                <div
                  key={step.label}
                  className={`company-demo-step flex gap-3 rounded-xl border bg-white p-3 shadow-sm ${
                    isVisible ? "is-visible" : ""
                  } ${isActive ? "is-active border-zinc-300" : "border-zinc-200"}`}
                >
                  <span
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                      index < phase
                        ? "bg-emerald-50 text-emerald-700"
                        : isActive
                          ? "bg-zinc-950 text-white"
                          : "bg-zinc-100 text-zinc-400"
                    }`}
                  >
                    {index < phase ? <Check className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold text-zinc-900">{step.label}</span>
                      <span className="ml-auto text-[8px] font-medium text-zinc-400">{step.meta}</span>
                    </span>
                    <span className="mt-1 block text-[9px] leading-4 text-zinc-500">{step.detail}</span>
                    {isActive && (
                      <span className="mt-2 block h-0.5 overflow-hidden rounded-full bg-zinc-100">
                        <span className="company-demo-progress block h-full origin-left rounded-full bg-zinc-950" />
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="hidden border-l border-white/10 bg-black/10 p-3 xl:block">
          <div className="text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-600">
            Human control
          </div>
          <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.07] p-3">
            <div className="flex items-center gap-2 text-[9px] font-semibold text-amber-200">
              <ShieldCheck className="h-3.5 w-3.5" />
              Approval gate
            </div>
            <p className="mt-2 text-[9px] leading-4 text-zinc-400">
              External actions pause until a Member is ready.
            </p>
            <div className="mt-3 rounded-lg bg-white px-2.5 py-2 text-center text-[8px] font-bold text-zinc-950">
              Review before action
            </div>
          </div>

          <div
            className={`mt-3 rounded-xl border p-3 transition ${
              phase === outcome.steps.length - 1
                ? "border-emerald-300/25 bg-emerald-300/[0.08]"
                : "border-white/10 bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-300 text-zinc-950">
                <Check className="h-3 w-3" />
              </span>
              <span className="text-[8px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                Outcome
              </span>
            </div>
            <p className="mt-2 text-[10px] font-semibold leading-4 text-white">{outcome.outcome}</p>
            <div className="mt-3 flex items-center gap-1 text-[8px] font-semibold text-zinc-500">
              Open run
              <ArrowUpRight className="h-2.5 w-2.5" />
            </div>
          </div>

          <div className="mt-5 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between text-[8px] text-zinc-600">
              <span>Context used</span>
              <span className="font-mono">4 grants</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[8px] text-zinc-600">
              <span>Run log</span>
              <span className="text-emerald-300">Auditable</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
